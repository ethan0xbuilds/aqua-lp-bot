import { afterAll, describe, expect, it, vi } from 'vitest';
import { runLoop, type LoopDeps } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { PositionsStore } from '../src/positions.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AquaClient } from '../src/aqua-client.js';
import type { Executor } from '../src/executor.js';
import type { PriceSource } from '../src/price/price-source.js';
import type { Position } from '../src/types.js';

const cfg = loadConfig({
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv);

const silentLogger = new Logger('error', 'logs');
const WALLET = '0x' + '22'.repeat(20) as `0x${string}`;

function fakePosition(over: Partial<Position> = {}): Position {
  return {
    strategyHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    side: 'inch',
    tokenAddress: cfg.tokenInch,
    lower: 0.3,
    upper: 0.30012,
    allocatedUsd: 6000,
    remainingUsd: 6000,
    openedAtMs: Date.now() - 300_000,
    ...over,
  };
}

/** 哨兵：首轮迭代结束后抛出让循环退出 */
class StopAfterOne extends Error {}

/** 记录测试创建的临时目录，结束后统一清理 */
const tmpDirs: string[] = [];

function makeDeps(over: Partial<LoopDeps> = {}, throwAfterIteration = 1): LoopDeps & { iterations: number } {
  let iterations = 0;
  const dir = mkdtempSync(join(tmpdir(), 'loop-'));
  tmpDirs.push(dir);
  const store = new PositionsStore(join(dir, 'positions.json'));
  const deps: LoopDeps = {
    cfg,
    walletAddress: WALLET,
    logger: silentLogger,
    priceSource: { getPrice: vi.fn().mockResolvedValue(0.3) } as PriceSource,
    publicClient: {
      readContract: vi.fn()
        .mockResolvedValueOnce(20000n * 10n ** 18n) // 1INCH 余额
        .mockResolvedValueOnce(0n), // USDT 余额 → 只有 1INCH 侧重
    } as never,
    store,
    executor: {
      ship: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)),
      dock: vi.fn().mockResolvedValue('0x' + 'aa'.repeat(32)),
      dockAll: vi.fn().mockResolvedValue([]),
    } as unknown as Executor,
    // getRemaining 返回 rawBalances 原始结构（余额 + tokensCount）：tokensCount=1 表示活仓
    aqua: {
      getRemaining: vi.fn().mockResolvedValue({ remaining: 20000n * 10n ** 18n, tokensCount: 1 }),
    } as unknown as AquaClient,
    sleep: vi.fn(async () => {
      if (++iterations >= throwAfterIteration) throw new StopAfterOne();
    }),
    ...over,
  };
  return { ...deps, iterations };
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('runLoop', () => {
  it('真实模式：开仓决策被 ship 执行并写入仓位表', async () => {
    const deps = makeDeps();
    await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
    expect((deps.executor.ship as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    const table = deps.store.load();
    expect(table).toHaveLength(1);
    expect(table[0].side).toBe('inch');
    expect(table[0].openedAtMs).toBeGreaterThan(0);
  });

  it('DRY_RUN：不广播，但假设执行成功推进仓位表', async () => {
    const deps = makeDeps({ cfg: { ...cfg, dryRun: true } });
    await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
    expect((deps.executor.ship as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    const table = deps.store.load();
    expect(table).toHaveLength(1);
    expect(table[0].strategyHash).toMatch(/^dry-/);
  });

  it('连续失败达到阈值 → dockAll 并退出', async () => {
    const deps = makeDeps({}, 3); // 允许跑 3 次失败迭代
    (deps.priceSource.getPrice as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('api down'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
      expect((deps.executor.dockAll as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore(); // 断言失败也恢复，避免污染其他测试
    }
  });

  it('熔断 dockAll 后：只删除确认 dock 成功的行，失败行保留在表（重启可继续处理）', async () => {
    const deps = makeDeps({}, 3);
    const posA = fakePosition({ strategyHash: ('0x' + '01'.repeat(32)) as `0x${string}` });
    const posB = fakePosition({ strategyHash: ('0x' + '02'.repeat(32)) as `0x${string}` });
    deps.store.save([posA, posB]);
    (deps.priceSource.getPrice as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('api down'));
    // dockAll 只成功平掉 posA；posB 广播失败 → 其行必须保留（删了会失去对未平仓位的管理）
    (deps.executor.dockAll as ReturnType<typeof vi.fn>).mockResolvedValue([posA.strategyHash]);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
      expect(deps.store.load().map((p) => p.strategyHash)).toEqual([posB.strategyHash]);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('熔断 dockAll 全部成功 → 表清空（无死行残留，重启不再 dock 它们）', async () => {
    const deps = makeDeps({}, 3);
    const posA = fakePosition({ strategyHash: ('0x' + '01'.repeat(32)) as `0x${string}` });
    const posB = fakePosition({ strategyHash: ('0x' + '02'.repeat(32)) as `0x${string}` });
    deps.store.save([posA, posB]);
    (deps.priceSource.getPrice as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('api down'));
    (deps.executor.dockAll as ReturnType<typeof vi.fn>).mockResolvedValue([posA.strategyHash, posB.strategyHash]);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
      expect(deps.store.load()).toEqual([]);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('乱序仓位表：喂给 decide 的两侧按 openedAtMs 升序（dock 先最旧）', async () => {
    const deps = makeDeps();
    const older = fakePosition({
      strategyHash: ('0x' + '01'.repeat(32)) as `0x${string}`,
      remainingUsd: 50, // 空壳 → 本轮 dock
      openedAtMs: 1_000,
    });
    const newer = fakePosition({
      strategyHash: ('0x' + '02'.repeat(32)) as `0x${string}`,
      remainingUsd: 50,
      openedAtMs: 2_000,
    });
    deps.store.save([newer, older]); // 故意乱序入表
    await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
    const dock = deps.executor.dock as ReturnType<typeof vi.fn>;
    expect(dock.mock.calls.map((c) => c[0])).toEqual([older.strategyHash, newer.strategyHash]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('价格源返回非有限值 %s → 本轮失败且不广播任何交易', async (bad) => {
    const deps = makeDeps({}, 1);
    (deps.priceSource.getPrice as ReturnType<typeof vi.fn>).mockResolvedValue(bad);
    await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
    expect((deps.executor.ship as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((deps.executor.dock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((deps.executor.dockAll as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it.each([0, -0.5])('价格源返回非正数 %s → 本轮失败且不广播（无守卫时 USDT 侧会 ship 零宽区间）', async (bad) => {
    const deps = makeDeps({}, 1);
    // 两侧余额都达标：没有 price<=0 守卫时 USDT 侧会开零宽区间 ship，
    // 本夹具保证守卫被删时 ship 调用数 > 0，锚定 price<=0 守卫存在
    const readContract = deps.publicClient.readContract as unknown as ReturnType<typeof vi.fn>;
    readContract.mockReset();
    readContract
      .mockResolvedValueOnce(20000n * 10n ** 18n) // 1INCH
      .mockResolvedValueOnce(6000n * 10n ** 6n); // 6000 USDT
    (deps.priceSource.getPrice as ReturnType<typeof vi.fn>).mockResolvedValue(bad);
    await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
    expect((deps.executor.ship as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((deps.executor.dock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((deps.executor.dockAll as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('真实模式：ship #1 成功、ship #2 广播抛错 → 磁盘表保留 #1', async () => {
    const deps = makeDeps();
    const hashA = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
    // 两侧资金都达标 → 本轮 2 个 ship（1INCH + USDT）
    const readContract = deps.publicClient.readContract as unknown as ReturnType<typeof vi.fn>;
    readContract.mockReset();
    readContract
      .mockResolvedValueOnce(20000n * 10n ** 18n) // 1INCH ≈ 6000U @0.3
      .mockResolvedValueOnce(6000n * 10n ** 6n); // 6000 USDT ≈ 6000U
    const ship = deps.executor.ship as ReturnType<typeof vi.fn>;
    ship.mockResolvedValueOnce(hashA).mockRejectedValueOnce(new Error('ship #2 broadcast fail'));
    await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
    const table = deps.store.load();
    expect(table).toHaveLength(1);
    expect(table[0].strategyHash).toBe(hashA);
  });

  it('真实模式：dock #1 成功、dock #2 抛错 → 磁盘表已无 #1、仍有 #2', async () => {
    const deps = makeDeps();
    const posA = fakePosition({
      strategyHash: ('0x' + '01'.repeat(32)) as `0x${string}`,
      remainingUsd: 50, // 空壳 → 本轮 dock
      openedAtMs: 1_000,
    });
    const posB = fakePosition({
      strategyHash: ('0x' + '02'.repeat(32)) as `0x${string}`,
      remainingUsd: 50,
      openedAtMs: 2_000,
    });
    deps.store.save([posA, posB]);
    const dock = deps.executor.dock as ReturnType<typeof vi.fn>;
    dock.mockResolvedValueOnce('0x' + 'aa'.repeat(32)).mockRejectedValueOnce(new Error('dock #2 broadcast fail'));
    await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
    const table = deps.store.load();
    expect(table.map((p) => p.strategyHash)).toEqual([posB.strategyHash]);
  });

  it('失败 1 次 → 成功 1 次 → 连续再失败 2 次：失败计数清零，不触发 dockAll', async () => {
    const deps = makeDeps({}, 4);
    // 阈值 3 下：计数正确清零 → 成功后连续失败停在 2，永不熔断；
    // 计数不清零（broken）→ 第 4 轮累计到 3 会调用 dockAll，本断言因此真正锚定清零行为
    (deps.priceSource.getPrice as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('fail a'))
      .mockResolvedValueOnce(0.3)
      .mockRejectedValue(new Error('fail b'));
    await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
    expect((deps.executor.dockAll as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((deps.executor.ship as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // 第 2 轮成功过
  });

  it('DRY_RUN 熔断：只 log 不广播 dockAll，exit(1)', async () => {
    const deps = makeDeps({ cfg: { ...cfg, dryRun: true } }, 3);
    (deps.priceSource.getPrice as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('api down'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
      expect((deps.executor.dockAll as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      expect((deps.executor.dock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      expect((deps.executor.ship as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('对账跳过 dry-* 占位行（不调 getRemaining），真实行照常对账，表保持完整', async () => {
    const deps = makeDeps({ cfg: { ...cfg, dryRun: true } });
    const dryPos = fakePosition({ strategyHash: 'dry-1234567890-inch' as `0x${string}` });
    const realPos = fakePosition({ strategyHash: ('0x' + 'cd'.repeat(32)) as `0x${string}` });
    deps.store.save([dryPos, realPos]);
    // inch 侧已有 2 仓（达上限）且价格在区间内 → 本轮无 dock/ship，只走对账
    const getRemaining = deps.aqua.getRemaining as ReturnType<typeof vi.fn>;
    getRemaining.mockResolvedValue({ remaining: 10000n * 10n ** 18n, tokensCount: 1 });
    await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
    expect(getRemaining).toHaveBeenCalledTimes(1); // dry 行绝不发链上查询
    expect(getRemaining).toHaveBeenCalledWith(realPos.strategyHash, realPos.tokenAddress);
    const table = deps.store.load();
    expect(table.map((p) => p.strategyHash).sort()).toEqual([dryPos.strategyHash, realPos.strategyHash].sort());
    const real = table.find((p) => p.strategyHash === realPos.strategyHash)!;
    expect(real.remainingUsd).toBeCloseTo(3000, 6); // 真实行对账结果落地
    const dry = table.find((p) => p.strategyHash === dryPos.strategyHash)!;
    expect(dry.remainingUsd).toBe(dryPos.remainingUsd); // dry 行原样保留
  });
});
