import { afterAll, describe, expect, it, vi } from 'vitest';
import { runLoop, type LoopDeps } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { PositionsStore } from '../src/positions.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      dockAll: vi.fn().mockResolvedValue(undefined),
    } as never,
    aqua: { getRemaining: vi.fn().mockResolvedValue(20000n * 10n ** 18n) } as never,
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
    await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
    expect((deps.executor.dockAll as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('价格源返回 %s → 本轮失败且不广播任何交易', async (bad) => {
    const deps = makeDeps({}, 1);
    (deps.priceSource.getPrice as ReturnType<typeof vi.fn>).mockResolvedValue(bad);
    await expect(runLoop(deps)).rejects.toBeInstanceOf(StopAfterOne);
    expect((deps.executor.ship as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((deps.executor.dock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((deps.executor.dockAll as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
