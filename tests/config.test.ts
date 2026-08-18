import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE_ENV = {
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('必填项缺失时抛错', () => {
    expect(() => loadConfig({})).toThrow(/PRIVATE_KEY/);
    expect(() => loadConfig({ ...BASE_ENV, RPC_URL: '' })).toThrow(/RPC_URL/);
  });

  it('应用默认值', () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.minSideValueUsd).toBe(6000);
    expect(cfg.priceDriftPct).toBe(0.0005);
    expect(cfg.positionMinIntervalS).toBe(240);
    expect(cfg.staleDistancePct).toBe(0.01);
    expect(cfg.emptyPositionThresholdUsd).toBe(100);
    expect(cfg.loopIntervalS).toBe(60);
    expect(cfg.maxPositionsPerSide).toBe(2);
    expect(cfg.maxConsecutiveFailures).toBe(3);
    expect(cfg.maxActionsPerLoop).toBe(4);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.chainId).toBe(1);
    expect(cfg.tokenInch).toBe('0x111111111117dC0aa78b770fA6A738034120C302');
    expect(cfg.tokenUsdt).toBe('0xdAC17F958D2ee523a2206206994597C13D831ec7');
    expect(cfg.tokenInchDecimals).toBe(18);
    expect(cfg.tokenUsdtDecimals).toBe(6);
  });

  it('env 可以覆盖默认值', () => {
    const cfg = loadConfig({ ...BASE_ENV, MIN_SIDE_VALUE_USD: '100', DRY_RUN: 'true' });
    expect(cfg.minSideValueUsd).toBe(100);
    expect(cfg.dryRun).toBe(true);
  });

  it('非法布尔值拒绝启动（安全开关不静默）', () => {
    expect(() => loadConfig({ ...BASE_ENV, DRY_RUN: 'TRUE' })).toThrow(/DRY_RUN/);
    expect(() => loadConfig({ ...BASE_ENV, DRY_RUN: 'ture' })).toThrow(/DRY_RUN/);
  });

  it('宽度档位按阈值降序排列', () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.widthTiersUsd).toEqual([
      { threshold: 9000, width: 0.0006 },
      { threshold: 6000, width: 0.0004 },
    ]);
  });
});
