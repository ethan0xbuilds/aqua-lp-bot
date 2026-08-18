import { describe, expect, it, vi } from 'vitest';
import { refreshRemaining } from '../src/events.js';
import { loadConfig } from '../src/config.js';
import type { AquaClient } from '../src/aqua-client.js';
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

describe('refreshRemaining', () => {
  it('按链上剩余余额更新 remainingUsd（估值换算）', async () => {
    const p = pos(); // 6000U = 2 万 1INCH @0.3
    const getRemaining = vi.fn().mockResolvedValue(10000n * 10n ** 18n); // 剩 1 万枚 → 3000U
    const aqua = { getRemaining } as unknown as AquaClient;

    const [updated] = await refreshRemaining(aqua, [p], 0.3, cfg);
    expect(updated.remainingUsd).toBeCloseTo(3000, 6);
    expect(getRemaining).toHaveBeenCalledWith(p.strategyHash, cfg.tokenInch);
  });

  it('单个仓位读取失败时保留原值并继续处理其他仓位', async () => {
    const p1 = pos();
    const p2 = pos({ strategyHash: ('0x' + 'cd'.repeat(32)) as `0x${string}`, side: 'usdt', tokenAddress: cfg.tokenUsdt });
    const getRemaining = vi.fn()
      .mockRejectedValueOnce(new Error('rpc down')) // p1 失败
      .mockResolvedValueOnce(500n * 10n ** 6n); // p2 剩 500 USDT → 500U
    const aqua = { getRemaining } as unknown as AquaClient;

    const updated = await refreshRemaining(aqua, [p1, p2], 0.3, cfg);
    expect(updated[0].remainingUsd).toBe(p1.remainingUsd); // 原值保留
    expect(updated[1].remainingUsd).toBeCloseTo(500, 6);
  });

  it('空仓位数组直接返回', async () => {
    const aqua = { getRemaining: vi.fn() } as unknown as AquaClient;
    expect(await refreshRemaining(aqua, [], 0.3, cfg)).toEqual([]);
  });
});
