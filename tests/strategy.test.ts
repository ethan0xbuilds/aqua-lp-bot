import { describe, expect, it } from 'vitest';
import { decide } from '../src/strategy.js';
import { loadConfig } from '../src/config.js';
import type { Position, SideState } from '../src/types.js';

const cfg = loadConfig({
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv);

const NOW = 1_700_000_000_000;
const P = 0.3; // 1INCH = 0.3 USDT

function pos(over: Partial<Position> = {}): Position {
  return {
    strategyHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    side: 'inch',
    tokenAddress: cfg.tokenInch,
    lower: P,
    upper: P * (1 + 0.0004),
    allocatedUsd: 6000,
    remainingUsd: 6000,
    openedAtMs: NOW - 300_000,
    ...over,
  };
}

function side(over: Partial<SideState> = {}): SideState {
  return {
    tokenBalance: 20000n * 10n ** 18n, // 2 万枚 1INCH ≈ 6000U @0.3
    balanceUsd: 6000,
    positions: [],
    ...over,
  };
}

const empty = side({ tokenBalance: 0n, balanceUsd: 0 });

describe('decide 开仓', () => {
  it('侧资金 ≥6000 且 0 仓 → 开首仓，重 1INCH 区间挂上方', () => {
    const d = decide(cfg, P, side(), empty, NOW);
    expect(d.ships).toHaveLength(1);
    const s = d.ships[0];
    expect(s.side).toBe('inch');
    expect(s.lower).toBe(P);
    expect(s.upper).toBeCloseTo(P * 1.0004, 10); // 6000U 档 → 0.04%
    expect(s.tokenAmount).toBe(20000n * 10n ** 18n); // 全额共享
  });

  it('侧资金 ≥9000 → 宽度 0.06%', () => {
    const heavy = side({ balanceUsd: 9000, tokenBalance: 30000n * 10n ** 18n });
    const d = decide(cfg, P, heavy, empty, NOW);
    expect(d.ships[0].upper).toBeCloseTo(P * 1.0006, 10);
  });

  it('重 USDT → 区间挂下方', () => {
    const d = decide(cfg, P, empty, side(), NOW);
    const s = d.ships[0];
    expect(s.side).toBe('usdt');
    expect(s.upper).toBe(P);
    expect(s.lower).toBeCloseTo(P * (1 - 0.0004), 10);
  });

  it('侧资金 <6000 → 不开仓', () => {
    const poor = side({ balanceUsd: 5999.99 });
    const d = decide(cfg, P, poor, empty, NOW);
    expect(d.ships).toHaveLength(0);
  });
});

describe('decide 二仓（滚动）', () => {
  it('间隔不足 240s 或偏离不足 0.05% → 不开二仓', () => {
    const state = side({ positions: [pos({ openedAtMs: NOW - 100_000 })] }); // 刚开 100s
    const d = decide(cfg, P, state, empty, NOW);
    expect(d.ships).toHaveLength(0);
  });

  it('间隔足够但价格未偏离 → 不开二仓', () => {
    const state = side({ positions: [pos({ openedAtMs: NOW - 300_000 })] });
    const d = decide(cfg, P, state, empty, NOW); // 价格正好在区间内
    expect(d.ships).toHaveLength(0);
  });

  it('间隔 ≥240s 且价格上穿区间 0.05% → 开二仓（重 1INCH 侧）', () => {
    const state = side({ positions: [pos({ openedAtMs: NOW - 300_000 })] });
    const drifted = P * 1.0004 * (1 + 0.0006); // 高于区间上限 0.05% 以上（严格大于）
    const d = decide(cfg, drifted, state, empty, NOW);
    expect(d.ships).toHaveLength(1);
    expect(d.ships[0].lower).toBe(drifted);
  });

  it('重 USDT 侧：价格下穿区间 0.05% → 开二仓', () => {
    const usdtPos = pos({ side: 'usdt', tokenAddress: cfg.tokenUsdt, lower: P * (1 - 0.0004), upper: P });
    const state = side({ positions: [usdtPos], tokenBalance: 20000n * 10n ** 6n, balanceUsd: 6000 });
    const dropped = P * (1 - 0.0004) * (1 - 0.0006); // 低于区间下限 0.05% 以上（严格小于）
    const d = decide(cfg, dropped, empty, state, NOW);
    expect(d.ships).toHaveLength(1);
    expect(d.ships[0].side).toBe('usdt');
  });

  it('该方向已有 2 仓 → 不再开', () => {
    const state = side({
      positions: [pos({ openedAtMs: NOW - 600_000 }), pos({ openedAtMs: NOW - 300_000 })],
    });
    const d = decide(cfg, P * 1.01, state, empty, NOW);
    expect(d.ships).toHaveLength(0);
  });
});

describe('decide 平仓', () => {
  it('空壳（剩余 <100U）→ dock，无论仓位数量', () => {
    const shell = pos({ remainingUsd: 99 });
    const state = side({ positions: [shell] });
    const d = decide(cfg, P, state, empty, NOW);
    expect(d.docks).toEqual([shell]);
  });

  it('陈旧：2 仓且最旧仓价格离开区间 >1% → dock 最旧', () => {
    const old = pos({ openedAtMs: NOW - 900_000 });
    const fresh = pos({ openedAtMs: NOW - 300_000 });
    const state = side({ positions: [old, fresh] });
    const d = decide(cfg, P * 1.02, state, empty, NOW); // 价格远离上方
    expect(d.docks).toEqual([old]);
    expect(d.docks).not.toContain(fresh);
  });

  it('仅 1 仓时即使偏离 >1% 也不平', () => {
    const only = pos({ openedAtMs: NOW - 900_000 });
    const state = side({ positions: [only] });
    const d = decide(cfg, P * 1.02, state, empty, NOW);
    expect(d.docks).toHaveLength(0);
  });
});

describe('decide 边界语义（严格/非严格不等式回归锚）', () => {
  it('空壳恰为 100U → 不平（严格小于）', () => {
    const at = pos({ remainingUsd: 100 });
    const state = side({ positions: [at] });
    const d = decide(cfg, P, state, empty, NOW);
    expect(d.docks).toHaveLength(0);
  });

  it('间隔恰为 240s 且价格偏离 → 开二仓（≥ 语义）', () => {
    const state = side({ positions: [pos({ openedAtMs: NOW - 240_000 })] });
    const drifted = P * 1.0004 * 1.0006; // 严格越过漂移阈值
    const d = decide(cfg, drifted, state, empty, NOW);
    expect(d.ships).toHaveLength(1);
  });

  it('价格恰在上限×(1+0.05%) → 不开二仓（严格大于）', () => {
    const state = side({ positions: [pos({ openedAtMs: NOW - 300_000 })] });
    const boundary = P * 1.0004 * 1.0005; // 恰为漂移阈值，不算越过
    const d = decide(cfg, boundary, state, empty, NOW);
    expect(d.ships).toHaveLength(0);
  });

  it('USDT 侧价格恰在下限×(1−0.05%) → 不开二仓（严格小于）', () => {
    const usdtPos = pos({ side: 'usdt', tokenAddress: cfg.tokenUsdt, lower: P * (1 - 0.0004), upper: P });
    const state = side({ positions: [usdtPos] });
    const boundary = P * (1 - 0.0004) * (1 - 0.0005);
    const d = decide(cfg, boundary, empty, state, NOW);
    expect(d.ships).toHaveLength(0);
  });

  it('陈旧恰在 1% 边界 → 不平（严格大于）', () => {
    const old = pos({ openedAtMs: NOW - 900_000 });
    const fresh = pos({ openedAtMs: NOW - 300_000 });
    const state = side({ positions: [old, fresh] });
    const boundary = P * 1.0004 * 1.01; // 恰为陈旧阈值，不算离开
    const d = decide(cfg, boundary, state, empty, NOW);
    expect(d.docks).toHaveLength(0);
  });
});

describe('decide 操作上限', () => {
  it('dock 优先，总操作数截断到 maxActionsPerLoop', () => {
    // 两侧各 1 空壳 + 两侧各可开 1 仓 = 4 操作；把上限临时压到 3 验证截断
    const cfg2 = { ...cfg, maxActionsPerLoop: 3 };
    const inchSide = side({ positions: [pos({ remainingUsd: 50 })] });
    const usdtSide = side({ positions: [pos({ side: 'usdt', tokenAddress: cfg.tokenUsdt, lower: P * (1 - 0.0004), upper: P, remainingUsd: 50 })] });
    const d = decide(cfg2, P, inchSide, usdtSide, NOW);
    expect(d.docks.length + d.ships.length).toBe(3);
    expect(d.docks).toHaveLength(2); // 空壳 2 个全平（优先级最高）
    expect(d.ships).toHaveLength(1);
  });

  it('决策附带中文理由', () => {
    const d = decide(cfg, P, side(), empty, NOW);
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.reasons[0]).toMatch(/inch/);
  });
});
