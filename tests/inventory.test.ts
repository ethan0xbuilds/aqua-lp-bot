import { describe, expect, it, vi } from 'vitest';
import { fetchBalances, toSideStates } from '../src/inventory.js';
import { loadConfig } from '../src/config.js';
import type { Position } from '../src/types.js';

const BASE_ENV = {
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv;

const cfg = loadConfig(BASE_ENV);
const WALLET = ('0x' + '22'.repeat(20)) as `0x${string}`;

function makePosition(over: Partial<Position> = {}): Position {
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

describe('fetchBalances', () => {
  it('读取两个代币的 balanceOf', async () => {
    const readContract = vi.fn()
      .mockResolvedValueOnce(2n * 10n ** 18n) // 2 枚 1INCH
      .mockResolvedValueOnce(1500n * 10n ** 6n); // 1500 USDT
    const publicClient = { readContract } as unknown as Parameters<typeof fetchBalances>[0];

    const balances = await fetchBalances(publicClient, WALLET, cfg);
    expect(balances).toEqual({ inch: 2n * 10n ** 18n, usdt: 1500n * 10n ** 6n });
    expect(readContract).toHaveBeenCalledTimes(2);
    // 确认两次调用的 token 地址与 owner 参数
    const firstArgs = readContract.mock.calls[0][0];
    expect(firstArgs.address).toBe(cfg.tokenInch);
    expect(firstArgs.args).toEqual([WALLET]);
  });
});

describe('toSideStates', () => {
  it('按价格估值并分侧归位', () => {
    const balances = { inch: 10000n * 10n ** 18n, usdt: 1500n * 10n ** 6n };
    const positions = [
      makePosition({ side: 'inch', openedAtMs: 200 }),
      makePosition({ side: 'inch', openedAtMs: 100 }),
      makePosition({ side: 'usdt', openedAtMs: 300 }),
    ];
    const { inch, usdt } = toSideStates(balances, 0.3, positions, cfg);
    expect(inch.balanceUsd).toBeCloseTo(3000, 6); // 10000 × 0.3
    expect(usdt.balanceUsd).toBeCloseTo(1500, 6);
    expect(inch.positions.map((p) => p.openedAtMs)).toEqual([100, 200]);
    expect(usdt.positions).toHaveLength(1);
  });
});
