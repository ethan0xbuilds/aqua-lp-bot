import { describe, expect, it, vi } from 'vitest';
import { refreshRemaining } from '../src/events.js';
import { loadConfig } from '../src/config.js';
import type { AquaClient } from '../src/aqua-client.js';
import type { Logger } from '../src/logger.js';
import type { Position } from '../src/types.js';

const cfg = loadConfig({
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv);

function pos(over: Partial<Position> = {}): Position {
  return {
    strategyHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    side: 'inch',
    tokenAddress: cfg.tokenInch,
    lower: 0.3,
    upper: 0.30012,
    allocatedUsd: 6000,
    remainingUsd: 6000,
    openedAtMs: 1_700_000_000_000,
    ...over,
  };
}

function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
  };
}

describe('refreshRemaining', () => {
  it('按链上剩余余额更新 remainingUsd（估值换算）', async () => {
    const p = pos(); // 6000U = 2 万 1INCH @0.3
    const getRemaining = vi
      .fn()
      .mockResolvedValue({ remaining: 10000n * 10n ** 18n, tokensCount: 1 }); // 剩 1 万枚 → 3000U
    const aqua = { getRemaining } as unknown as AquaClient;
    const logger = fakeLogger();

    const [updated] = await refreshRemaining(aqua, [p], 0.3, cfg, logger);
    expect(updated.remainingUsd).toBeCloseTo(3000, 6);
    expect(getRemaining).toHaveBeenCalledWith(p.strategyHash, cfg.tokenInch);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('单个仓位读取失败时保留原值并继续处理其他仓位（warn 留痕）', async () => {
    const p1 = pos();
    const p2 = pos({ strategyHash: ('0x' + 'cd'.repeat(32)) as `0x${string}`, side: 'usdt', tokenAddress: cfg.tokenUsdt });
    const getRemaining = vi
      .fn()
      .mockRejectedValueOnce(new Error('rpc down')) // p1 失败
      .mockResolvedValueOnce({ remaining: 500n * 10n ** 6n, tokensCount: 1 }); // p2 剩 500 USDT → 500U
    const aqua = { getRemaining } as unknown as AquaClient;
    const logger = fakeLogger();

    const updated = await refreshRemaining(aqua, [p1, p2], 0.3, cfg, logger);
    expect(updated[0].remainingUsd).toBe(p1.remainingUsd); // 原值保留
    expect(updated[1].remainingUsd).toBeCloseTo(500, 6);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain(p1.strategyHash);
  });

  it('tokensCount=0xff（已 dock）→ 死行剔除并 warn 注明原因', async () => {
    const p = pos();
    const getRemaining = vi.fn().mockResolvedValue({ remaining: 0n, tokensCount: 0xff });
    const aqua = { getRemaining } as unknown as AquaClient;
    const logger = fakeLogger();

    expect(await refreshRemaining(aqua, [p], 0.3, cfg, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = String(logger.warn.mock.calls[0][0]);
    expect(msg).toContain(p.strategyHash);
    expect(msg).toContain('0xff');
  });

  it('tokensCount=0（从未 ship）→ 死行剔除并 warn 注明原因', async () => {
    const p = pos();
    const getRemaining = vi.fn().mockResolvedValue({ remaining: 0n, tokensCount: 0 });
    const aqua = { getRemaining } as unknown as AquaClient;
    const logger = fakeLogger();

    expect(await refreshRemaining(aqua, [p], 0.3, cfg, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = String(logger.warn.mock.calls[0][0]);
    expect(msg).toContain(p.strategyHash);
    expect(msg).toContain('tokensCount=0');
  });

  it('死行只剔除自己，健康行照常更新', async () => {
    const dead = pos({ strategyHash: ('0x' + 'cd'.repeat(32)) as `0x${string}` });
    const alive = pos(); // '0x' + 'ab'.repeat(32)
    const getRemaining = vi
      .fn()
      .mockResolvedValueOnce({ remaining: 0n, tokensCount: 0xff }) // dead
      .mockResolvedValueOnce({ remaining: 10000n * 10n ** 18n, tokensCount: 1 }); // alive
    const aqua = { getRemaining } as unknown as AquaClient;
    const logger = fakeLogger();

    const updated = await refreshRemaining(aqua, [dead, alive], 0.3, cfg, logger);
    expect(updated.map((x) => x.strategyHash)).toEqual([alive.strategyHash]);
    expect(updated[0].remainingUsd).toBeCloseTo(3000, 6);
  });

  it('空仓位数组直接返回', async () => {
    const aqua = { getRemaining: vi.fn() } as unknown as AquaClient;
    expect(await refreshRemaining(aqua, [], 0.3, cfg, fakeLogger())).toEqual([]);
  });
});
