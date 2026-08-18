/**
 * 全部参数集中在此：默认值 + .env 覆盖。
 * 用户后期调参只改 .env，不必读代码。
 */

export interface WidthTier {
  /** 侧资金达到该阈值（U）时适用的区间宽度 */
  threshold: number;
  /** 区间宽度（比例，如 0.0006 = 0.06%），降序排列 */
  width: number;
}

export interface Config {
  // 必填（.env）
  privateKey: `0x${string}`;
  rpcUrl: string;
  apiKey1inch: string;
  // 链与交易对
  chainId: number;
  tokenInch: `0x${string}`;
  tokenUsdt: `0x${string}`;
  tokenInchDecimals: number;
  tokenUsdtDecimals: number;
  // 策略参数
  minSideValueUsd: number;
  widthTiersUsd: WidthTier[];
  maxPositionsPerSide: number;
  staleDistancePct: number;
  emptyPositionThresholdUsd: number;
  priceDriftPct: number;
  positionMinIntervalS: number;
  // 运行参数
  loopIntervalS: number;
  maxConsecutiveFailures: number;
  maxActionsPerLoop: number;
  dryRun: boolean;
}

const DEFAULTS = {
  chainId: 1,
  tokenInch: '0x111111111117dC0aa78b770fA6A738034120C302',
  tokenUsdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  tokenInchDecimals: 18,
  tokenUsdtDecimals: 6,
  minSideValueUsd: 6000,
  widthTiersUsd: [
    { threshold: 9000, width: 0.0006 },
    { threshold: 6000, width: 0.0004 },
  ],
  maxPositionsPerSide: 2,
  staleDistancePct: 0.01,
  emptyPositionThresholdUsd: 100,
  priceDriftPct: 0.0005,
  positionMinIntervalS: 240,
  loopIntervalS: 60,
  maxConsecutiveFailures: 3,
  maxActionsPerLoop: 4,
  dryRun: false,
} as const;

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (Number.isNaN(v)) throw new Error(`环境变量 ${key} 不是有效数字: ${raw}`);
  return v;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`缺少必填环境变量 ${key}（参考 .env.example）`);
  return v;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const privateKey = required(env, 'PRIVATE_KEY') as `0x${string}`;
  const rpcUrl = required(env, 'RPC_URL');
  const apiKey1inch = required(env, 'API_KEY_1INCH');

  return {
    privateKey,
    rpcUrl,
    apiKey1inch,
    chainId: num(env, 'CHAIN_ID', DEFAULTS.chainId),
    tokenInch: DEFAULTS.tokenInch,
    tokenUsdt: DEFAULTS.tokenUsdt,
    tokenInchDecimals: DEFAULTS.tokenInchDecimals,
    tokenUsdtDecimals: DEFAULTS.tokenUsdtDecimals,
    minSideValueUsd: num(env, 'MIN_SIDE_VALUE_USD', DEFAULTS.minSideValueUsd),
    // 展开为可变数组：DEFAULTS 是 as const，直接引用 readonly 无法赋给 WidthTier[]
    widthTiersUsd: [...DEFAULTS.widthTiersUsd],
    maxPositionsPerSide: num(env, 'MAX_POSITIONS_PER_SIDE', DEFAULTS.maxPositionsPerSide),
    staleDistancePct: num(env, 'STALE_DISTANCE_PCT', DEFAULTS.staleDistancePct),
    emptyPositionThresholdUsd: num(env, 'EMPTY_POSITION_THRESHOLD_USD', DEFAULTS.emptyPositionThresholdUsd),
    priceDriftPct: num(env, 'PRICE_DRIFT_PCT', DEFAULTS.priceDriftPct),
    positionMinIntervalS: num(env, 'POSITION_MIN_INTERVAL_S', DEFAULTS.positionMinIntervalS),
    loopIntervalS: num(env, 'LOOP_INTERVAL_S', DEFAULTS.loopIntervalS),
    maxConsecutiveFailures: num(env, 'MAX_CONSECUTIVE_FAILURES', DEFAULTS.maxConsecutiveFailures),
    maxActionsPerLoop: num(env, 'MAX_ACTIONS_PER_LOOP', DEFAULTS.maxActionsPerLoop),
    dryRun: bool(env, 'DRY_RUN', DEFAULTS.dryRun),
  };
}
