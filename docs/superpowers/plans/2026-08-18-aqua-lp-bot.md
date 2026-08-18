# aqua-lp-bot 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个在 1inch Aqua（Ethereum 主网，1INCH/USDT）自动挂/平单边流动性仓位的 TypeScript Bot，复刻用户的滚动跟价做市策略。

**Architecture:** 单进程定时轮询 keeper：每 60s 取价 → 读余额估值 → 纯函数决策（开/平仓）→ ship/dock 执行（只做链上记账）→ 状态持久化与熔断。SDK 相关逻辑隔离在 `aqua-client.ts` 一层，策略决策（`strategy.ts`）为纯函数可单测。

**Tech Stack:** Node 22 / TypeScript（strict）/ viem / @1inch/aqua-sdk / @1inch/swap-vm-sdk / dotenv / vitest / tsx。运行于 Mac 本地（无部署、无 Telegram）。

**Spec:** `docs/superpowers/specs/2026-08-18-aqua-lp-bot-design.md`

## Global Constraints

- 链：Ethereum 主网（chainId=1）；交易对 1INCH/USDT
- 代币地址：1INCH `0x111111111117dC0aa78b770fA6A738034120C302`（18 位小数），USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`（6 位小数）
- 参数默认值（config.ts 集中定义，可用 .env 覆盖）：`minSideValueUsd=6000`、宽度档位 `{9000:0.0006, 6000:0.0004}`、`maxPositionsPerSide=2`、`staleDistancePct=0.01`、`emptyPositionThresholdUsd=100`、`loopIntervalS=60`、`priceDriftPct=0.0005`、`positionMinIntervalS=240`、`maxConsecutiveFailures=3`、`maxActionsPerLoop=4`、`dryRun=false`
- 私钥仅存本地 `.env`（gitignored），Public 仓库任何文件不得含密钥
- 代码注释用中文；所有模块化、可读性优先（用户后期接手调参）
- 只 dock 本地仓位表（白名单）内的 strategyHash，绝不碰钱包里其他仓位
- 熔断：连续失败 ≥3 → dock 全部自己仓位 → `process.exit(1)`
- Node ≥20，ESM，TypeScript strict

---

### Task 1: 脚手架与基础类型

**Files:**
- Create: `package.json`、`tsconfig.json`、`tsconfig.build.json`、`vitest.config.ts`、`.gitignore`、`.env.example`、`src/types.ts`、`src/logger.ts`、`tests/smoke.test.ts`

**Interfaces:**
- Produces: `src/types.ts` 中的类型供所有后续任务使用（见下方代码）；`Logger` 类（`debug/info/warn/error(msg, meta?)`）供所有模块使用

- [ ] **Step 1: 创建 package.json 并安装依赖**

```bash
cd /Users/ethan/workspace/aqua-lp-bot
npm init -y
npm pkg set name="aqua-lp-bot" version="0.1.0" type="module" main="dist/main.js" private=true engines.node=">=20"
npm pkg set scripts.dev="tsx watch src/main.ts" scripts.build="tsc -p tsconfig.build.json" scripts.start="tsx src/main.ts" scripts.test="vitest run" scripts.smoke="tsx scripts/smoke-test.ts" scripts.typecheck="tsc --noEmit"
npm install viem @1inch/aqua-sdk @1inch/swap-vm-sdk dotenv
npm install -D typescript tsx vitest @types/node
```

- [ ] **Step 2: 写 tsconfig.json（typecheck 用）**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "scripts", "tests"]
}
```

- [ ] **Step 3: 写 tsconfig.build.json（编译用）**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src", "declaration": false, "sourceMap": true },
  "include": ["src"]
}
```

- [ ] **Step 4: 写 .gitignore 与 .env.example**

`.gitignore` 内容：

```
node_modules/
dist/
.env
logs/
data/
*.log
```

`.env.example` 内容：

```
# ===== 必填 =====
# 做市钱包私钥（仅存本地，绝不提交）
PRIVATE_KEY=
# Ethereum 主网 RPC URL
RPC_URL=
# 1inch developer portal 申请：https://portal.1inch.dev
API_KEY_1INCH=

# ===== 可选（覆盖默认值）=====
# LOOP_INTERVAL_S=60
# MIN_SIDE_VALUE_USD=6000
# PRICE_DRIFT_PCT=0.0005
# POSITION_MIN_INTERVAL_S=240
# STALE_DISTANCE_PCT=0.01
# EMPTY_POSITION_THRESHOLD_USD=100
# MAX_CONSECUTIVE_FAILURES=3
# MAX_ACTIONS_PER_LOOP=4
# DRY_RUN=false
```

- [ ] **Step 5: 写 src/types.ts**

```ts
/**
 * 全局共享类型定义。
 * 价格一律为「1 枚 1INCH 兑多少 USDT」的浮点数；金额一律为 U（美元估值）。
 */

/** 仓位方向：inch=重 1INCH（卖 1INCH，区间挂上方）；usdt=重 USDT（卖 USDT，区间挂下方） */
export type Side = 'inch' | 'usdt';

/** 一个已开（或假设已开，干跑模式）的 Aqua 仓位 */
export interface Position {
  strategyHash: `0x${string}`;
  side: Side;
  /** 该仓位对应的代币地址（dock 时需要） */
  tokenAddress: `0x${string}`;
  /** 价格区间（USDT/1INCH）：卖 1INCH 挂在当前价上方，卖 USDT 挂在下方 */
  lower: number;
  upper: number;
  /** 开仓时分配的估值（U） */
  allocatedUsd: number;
  /** 剩余虚拟余额估值（U），随成交递减；低于 emptyPositionThresholdUsd 视为空壳 */
  remainingUsd: number;
  /** 开仓时间（epoch ms），用于「最旧先平」与二仓间隔判断 */
  openedAtMs: number;
}

/** 待开新仓（决策产物） */
export interface NewPosition {
  side: Side;
  lower: number;
  upper: number;
  /** 该侧代币数量（原生单位）。Aqua 共享资金：用该侧钱包全额做虚拟分配 */
  tokenAmount: bigint;
}

/** 某一侧（1INCH 侧或 USDT 侧）的决策输入状态 */
export interface SideState {
  /** 该侧钱包代币余额（原生单位） */
  tokenBalance: bigint;
  /** 该侧估值（U） */
  balanceUsd: number;
  /** 该方向现存仓位，按 openedAtMs 升序 */
  positions: Position[];
}

/** 一次循环的决策产物 */
export interface Decision {
  /** 要 dock 的仓位（先于 ships 执行） */
  docks: Position[];
  /** 要 ship 的新仓位 */
  ships: NewPosition[];
  /** 人类可读的决策理由（写日志用） */
  reasons: string[];
}
```

- [ ] **Step 6: 写 src/logger.ts**

```ts
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 极简结构化日志：控制台 + logs/app-YYYY-MM-DD.log 滚动文件。
 * 无外部依赖；无 Telegram 通知（用户要求）。
 */
export class Logger {
  private filePath: string;

  constructor(private level: Level = 'info', logDir = 'logs') {
    mkdirSync(logDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.filePath = join(logDir, `app-${day}.log`);
  }

  private write(level: Level, msg: string, meta?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}${meta !== undefined ? ' ' + JSON.stringify(meta) : ''}`;
    console[level === 'debug' ? 'log' : level](line);
    appendFileSync(this.filePath, line + '\n');
  }

  debug(msg: string, meta?: unknown): void { this.write('debug', msg, meta); }
  info(msg: string, meta?: unknown): void { this.write('info', msg, meta); }
  warn(msg: string, meta?: unknown): void { this.write('warn', msg, meta); }
  error(msg: string, meta?: unknown): void { this.write('error', msg, meta); }
}
```

- [ ] **Step 7: 写 tests/smoke.test.ts 验证测试框架可用**

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../src/logger.js';

describe('smoke', () => {
  it('logger 能写入日志目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aqua-lp-bot-smoke-'));
    const day = new Date().toISOString().slice(0, 10);
    const logger = new Logger('debug', dir);
    logger.info('smoke test');
    // 断言真实行为：日志文件已生成且包含该行（写入临时目录，不在仓库留痕）
    const file = join(dir, `app-${day}.log`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('smoke test');
  });
});
```

- [ ] **Step 8: 验证**

Run: `npm test` → PASS；`npm run typecheck` → 无错误

- [ ] **Step 9: 提交**

```bash
git add -A && git commit -m "chore: 脚手架、基础类型与日志模块"
git push
```

---

### Task 2: config.ts（参数集中定义 + .env 加载）

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `Config` 接口与 `loadConfig(env: NodeJS.ProcessEnv): Config`（所有任务的参数来源）

- [ ] **Step 1: 写失败测试 tests/config.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const BASE_ENV = {
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('必填项缺失时抛错', () => {
    expect(() => loadConfig({})).toThrow(/PRIVATE_KEY/);
    expect(() => loadConfig({ ...BASE_ENV, PRIVATE_KEY: '' })).toThrow(/RPC_URL/);
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL（`Cannot find module '../src/config'`）

- [ ] **Step 3: 实现 src/config.ts**

```ts
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
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  // 安全开关（DRY_RUN）绝不静默：拼写错误/大小写错误一律拒绝启动
  throw new Error(`环境变量 ${key} 不是有效布尔值: ${raw}（应为 true/false 或 1/0）`);
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
    widthTiersUsd: DEFAULTS.widthTiersUsd,
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/config.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: config 参数集中定义与 .env 加载"
git push
```

---

### Task 3: SDK 探索与 aqua-client 封装（spike）

**Files:**
- Create: `src/aqua-client.ts`、`docs/SDK_NOTES.md`

**Interfaces:**
- Produces: `AquaClient` 接口与 `createAquaClient(cfg: Config): Promise<AquaClient>`（executor/loop 依赖）；`TxRequest`、`ShipPlan` 类型

- [ ] **Step 1: 转储 SDK 类型定义并阅读**

```bash
ls node_modules/@1inch/aqua-sdk/dist node_modules/@1inch/swap-vm-sdk/dist 2>/dev/null || ls node_modules/@1inch/aqua-sdk node_modules/@1inch/swap-vm-sdk
find node_modules/@1inch/aqua-sdk -name "*.d.ts" | head -20
find node_modules/@1inch/swap-vm-sdk -name "*.d.ts" | head -20
```

阅读导出的类型，重点确认以下问题的精确答案并记录到 `docs/SDK_NOTES.md`（用中文）：

1. `ship()` 的精确入参/出参：如何传入 strategy 程序字节与 amountsAndTokens？返回的 `{to, data, value}` 字段名？
2. `dock()` 的精确入参：strategyHash 类型、tokens 是否必传？
3. `calculateStrategyHash` 的入参类型（strategy 字节？是否含 amounts？）——ship 后如何得到新仓位的 strategyHash？
4. 单边卖 1INCH 的窄区间仓位程序怎么构造：`AquaXYCAmmStrategy` / `XYCConcentrate` 等类的构造参数（区间上下限的精度格式——是否要 scale 到整数？）与 Order 编码方式
5. 事件解码器：`ShippedEvent/DockedEvent/PushedEvent/PulledEvent.fromLog()` 是否存在、字段结构（Pushed/Pulled 是否带数量）
6. 如何读取某 strategyHash 的剩余虚拟余额（coverage / balanceOf 等只读函数）
7. `AQUA_CONTRACT_ADDRESSES` 的导出形态与各链注册表地址

官方文档参考（必要时 WebFetch）：https://business.1inch.com/portal/documentation/aqua/getting-started/strategy-template 与 https://business.1inch.com/portal/documentation/sdks/aqua-sdk

- [ ] **Step 2: 写 docs/SDK_NOTES.md**

记录 Step 1 的全部答案，每一条附上实际函数签名（从 .d.ts 复制，不要凭记忆）。此文件是后续 executor/events 任务的依据，同时是用户后期接手的参考资料。

- [ ] **Step 3: 实现 src/aqua-client.ts**

按以下接口实现（内部调用以 SDK_NOTES.md 记录的真实签名为准）：

```ts
import type { Config, NewPosition, Side } from './types';

/** 一次链上交易请求（viem 兼容） */
export interface TxRequest {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

/** ship 的计划产物：交易 + 新仓位的 strategyHash（SDK 预测值） */
export interface ShipPlan {
  tx: TxRequest;
  strategyHash: `0x${string}`;
}

/**
 * Aqua SDK 的薄封装：全项目只有这一个文件 import @1inch/* 包。
 * 换 SDK 版本/接口时只需改这里。
 */
export interface AquaClient {
  /** 构建 ship 交易：按 NewPosition 编码策略程序并预测 strategyHash */
  buildShip(pos: NewPosition, walletAddress: `0x${string}`): Promise<ShipPlan>;
  /** 构建 dock 交易 */
  buildDock(strategyHash: `0x${string}`, tokenAddress: `0x${string}`): Promise<TxRequest>;
  /** 读取仓位剩余虚拟余额（原生单位），用于空壳判定与对账 */
  getRemaining(strategyHash: `0x${string}`, tokenAddress: `0x${string}`): Promise<bigint>;
}

export async function createAquaClient(cfg: Config): Promise<AquaClient> {
  // 依据 SDK_NOTES.md 实现三个方法。
  // 关键点：
  //  - 区间上下限的精度格式以 SDK 要求的为准（可能需按 token 小数位 scale）
  //  - ship 后 strategyHash 取 SDK 预测值（calculateStrategyHash 或等价物）
  //  - tokenAddress 映射：side==='inch' → cfg.tokenInch，否则 cfg.tokenUsdt
  throw new Error('在 Step 3 中实现');
}
```

注意：若探索发现 `getRemaining` 只能通过事件累计实现（无链上只读函数），则改为实现 `decodeFillEvents(logs): { strategyHash, amountOut }[]` 并在 SDK_NOTES.md 中说明，同时更新 events 任务的消费方式。

- [ ] **Step 4: 编译验证**

Run: `npm run typecheck` → 无错误（实现真实签名，删除 Step 3 中的 throw）

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: Aqua SDK 封装层与 SDK_NOTES 文档"
git push
```

---

### Task 4: positions.ts（仓位状态表 + 持久化）

**Files:**
- Create: `src/positions.ts`
- Test: `tests/positions.test.ts`

**Interfaces:**
- Consumes: `Position`、`Side`（types.ts）
- Produces: `PositionsStore`（`load(): Position[]`、`save(positions: Position[]): void`）、`bySide(positions: Position[], side: Side): Position[]`

- [ ] **Step 1: 写失败测试 tests/positions.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PositionsStore, bySide } from '../src/positions';
import type { Position } from '../src/types';

function makePosition(over: Partial<Position> = {}): Position {
  return {
    strategyHash: '0x' + 'ab'.repeat(32),
    side: 'inch',
    tokenAddress: '0x111111111117dC0aa78b770fA6A738034120C302',
    lower: 0.3,
    upper: 0.30012,
    allocatedUsd: 6000,
    remainingUsd: 6000,
    openedAtMs: 1_700_000_000_000,
    ...over,
  };
}

describe('PositionsStore', () => {
  it('文件不存在时 load 返回空数组', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pos-'));
    const store = new PositionsStore(join(dir, 'positions.json'));
    expect(store.load()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('save 后 load 还原相同内容', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pos-'));
    const store = new PositionsStore(join(dir, 'positions.json'));
    const positions = [makePosition(), makePosition({ side: 'usdt', openedAtMs: 1_700_000_060_000 })];
    store.save(positions);
    expect(store.load()).toEqual(positions);
    rmSync(dir, { recursive: true, force: true });
  });

  it('bySide 按侧过滤并按开仓时间升序', () => {
    const p1 = makePosition({ side: 'inch', openedAtMs: 300 });
    const p2 = makePosition({ side: 'inch', openedAtMs: 100 });
    const p3 = makePosition({ side: 'usdt', openedAtMs: 200 });
    expect(bySide([p1, p2, p3], 'inch')).toEqual([p2, p1]);
    expect(bySide([p1, p2, p3], 'usdt')).toEqual([p3]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/positions.test.ts`
Expected: FAIL（`Cannot find module '../src/positions'`）

- [ ] **Step 3: 实现 src/positions.ts**

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Position, Side } from './types';

/**
 * 仓位状态表：Bot 开过的仓位（白名单）的本地持久化。
 * 文件：data/positions.json（gitignored）。重启进程不丢表。
 */
export class PositionsStore {
  constructor(private filePath: string) {}

  load(): Position[] {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as Position[];
    } catch (err) {
      // 白名单表损坏必须留痕（真钱安全）：记录原因后从空表开始，链上对账会补正
      console.warn('仓位表读取失败，从空表开始：', err);
      return [];
    }
  }

  save(positions: Position[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(positions, null, 2));
  }
}

/** 过滤出某方向的仓位，按开仓时间升序（index 0 最旧） */
export function bySide(positions: Position[], side: Side): Position[] {
  return positions
    .filter((p) => p.side === side)
    .sort((a, b) => a.openedAtMs - b.openedAtMs);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/positions.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 仓位状态表与 JSON 持久化"
git push
```

---

### Task 5: 价格源（PriceSource 接口 + Spot Price API 实现）

**Files:**
- Create: `src/price/price-source.ts`、`src/price/spot-price-api.ts`
- Test: `tests/spot-price-api.test.ts`

**Interfaces:**
- Consumes: `Config`（config.ts）
- Produces: `PriceSource`（`getPrice(): Promise<number>`，返回 1 枚 1INCH 兑多少 USDT）、`SpotPriceApi`

- [ ] **Step 1: 写失败测试 tests/spot-price-api.test.ts**

```ts
import { describe, expect, it, vi } from 'vitest';
import { SpotPriceApi } from '../src/price/spot-price-api';

const INCH_ADDR = '0x111111111117dC0aa78b770fA6A738034120C302';
const USDT_ADDR = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

function mockFetch(responses: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    const body = u.includes(INCH_ADDR.toLowerCase()) ? responses.inch : responses.usdt;
    return { ok: true, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

function makeApi(fetchFn: typeof fetch): SpotPriceApi {
  return new SpotPriceApi({ apiKey: 'key', tokenInch: INCH_ADDR, tokenUsdt: USDT_ADDR, chainId: 1 }, fetchFn);
}

describe('SpotPriceApi', () => {
  it('返回 1INCH/USDT 价格 = 两币 USD 价相除', async () => {
    const fetchFn = mockFetch({ inch: { usd: 0.3 }, usdt: { usd: 1.0 } });
    expect(await makeApi(fetchFn).getPrice()).toBeCloseTo(0.3, 10);
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const headers = calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer key');
  });

  it('USDT 不为 1 时也能正确相除', async () => {
    const fetchFn = mockFetch({ inch: { usd: 0.3 }, usdt: { usd: 0.998 } });
    expect(await makeApi(fetchFn).getPrice()).toBeCloseTo(0.3 / 0.998, 10);
  });

  it('HTTP 非 2xx 抛错', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 403 }) as Response) as unknown as typeof fetch;
    await expect(makeApi(fetchFn).getPrice()).rejects.toThrow(/403/);
  });

  it('响应缺少 usd 字段抛错', async () => {
    const fetchFn = mockFetch({ inch: {}, usdt: { usd: 1.0 } });
    await expect(makeApi(fetchFn).getPrice()).rejects.toThrow(/usd/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/spot-price-api.test.ts`
Expected: FAIL（`Cannot find module '../src/price/spot-price-api'`）

- [ ] **Step 3: 实现 src/price/price-source.ts**

```ts
/**
 * 价格源接口：返回 1 枚 1INCH 兑多少 USDT。
 * 未来可替换为 swapVm.quote 等其他实现。
 */
export interface PriceSource {
  getPrice(): Promise<number>;
}
```

- [ ] **Step 4: 实现 src/price/spot-price-api.ts**

```ts
import type { PriceSource } from './price-source';

const API_BASE = 'https://api.1inch.dev/price/v1.0';

export interface SpotPriceApiOptions {
  apiKey: string;
  tokenInch: `0x${string}`;
  tokenUsdt: `0x${string}`;
  chainId: number;
}

/**
 * 1inch Spot Price API（与 Aqua 页面显示价格同源）。
 * 文档：https://business.1inch.com/portal/documentation/overview/products
 * key 申请：https://portal.1inch.dev
 */
export class SpotPriceApi implements PriceSource {
  constructor(
    private opts: SpotPriceApiOptions,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async getPrice(): Promise<number> {
    const [inchUsd, usdtUsd] = await Promise.all([
      this.fetchUsd(this.opts.tokenInch),
      this.fetchUsd(this.opts.tokenUsdt),
    ]);
    return inchUsd / usdtUsd;
  }

  private async fetchUsd(token: `0x${string}`): Promise<number> {
    const url = `${API_BASE}/${this.opts.chainId}/${token.toLowerCase()}?currency=USD`;
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });
    if (!res.ok) throw new Error(`Spot Price API 请求失败: HTTP ${res.status}`);
    const data = (await res.json()) as { usd?: number };
    if (typeof data.usd !== 'number') throw new Error('Spot Price API 响应缺少 usd 字段');
    return data.usd;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- tests/spot-price-api.test.ts` → PASS

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: 价格源接口与 1inch Spot Price API 实现"
git push
```

---

### Task 6: inventory.ts（余额读取与两侧估值）

**Files:**
- Create: `src/inventory.ts`
- Test: `tests/inventory.test.ts`

**Interfaces:**
- Consumes: `Config`、`SideState`、`Position`（types.ts）
- Produces: `Balances`、`fetchBalances(publicClient: PublicClient, walletAddress: \`0x${string}\`, cfg: Config): Promise<Balances>`、`toSideStates(balances: Balances, price: number, positions: Position[], cfg: Config): { inch: SideState; usdt: SideState }`

- [ ] **Step 1: 写失败测试 tests/inventory.test.ts**

```ts
import { describe, expect, it, vi } from 'vitest';
import { fetchBalances, toSideStates } from '../src/inventory';
import { loadConfig } from '../src/config';
import type { Position } from '../src/types';

const BASE_ENV = {
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv;

const cfg = loadConfig(BASE_ENV);
const WALLET = '0x' + '22'.repeat(20) as `0x${string}`;

function makePosition(over: Partial<Position> = {}): Position {
  return {
    strategyHash: '0x' + 'ab'.repeat(32),
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/inventory.test.ts`
Expected: FAIL（`Cannot find module '../src/inventory'`）

- [ ] **Step 3: 实现 src/inventory.ts**

```ts
import type { PublicClient } from 'viem';
import type { Config } from './config';
import { bySide } from './positions';
import type { Position, SideState } from './types';

/** 钱包两侧代币余额（原生单位） */
export interface Balances {
  inch: bigint;
  usdt: bigint;
}

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** 读取钱包 1INCH / USDT 余额（Aqua 资金自托管：余额即全部可用资金） */
export async function fetchBalances(
  publicClient: PublicClient,
  walletAddress: `0x${string}`,
  cfg: Config,
): Promise<Balances> {
  const [inch, usdt] = await Promise.all([
    publicClient.readContract({
      address: cfg.tokenInch,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [walletAddress],
    }),
    publicClient.readContract({
      address: cfg.tokenUsdt,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [walletAddress],
    }),
  ]);
  return { inch, usdt };
}

function toUsd(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

/**
 * 把余额 + 仓位表组装成两侧决策输入。
 * 估值用当前价格 P；仓位按方向归位（已升序）。
 * 注意：Aqua 共享资金，侧资金 = 钱包全额估值，不扣除已分配。
 */
export function toSideStates(
  balances: Balances,
  price: number,
  positions: Position[],
  cfg: Config,
): { inch: SideState; usdt: SideState } {
  const inchUsd = toUsd(balances.inch, cfg.tokenInchDecimals) * price;
  const usdtUsd = toUsd(balances.usdt, cfg.tokenUsdtDecimals);
  return {
    inch: { tokenBalance: balances.inch, balanceUsd: inchUsd, positions: bySide(positions, 'inch') },
    usdt: { tokenBalance: balances.usdt, balanceUsd: usdtUsd, positions: bySide(positions, 'usdt') },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/inventory.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 余额读取与两侧估值"
git push
```

---

### Task 7: strategy.ts（决策纯函数——核心）

**Files:**
- Create: `src/strategy.ts`
- Test: `tests/strategy.test.ts`

**Interfaces:**
- Consumes: `Config`、`Decision`、`NewPosition`、`SideState`、`Position`、`Side`（types.ts）
- Produces: `decide(cfg: Config, price: number, inch: SideState, usdt: SideState, nowMs: number): Decision`

规则（照 spec）：
- 空壳清理：`remainingUsd < cfg.emptyPositionThresholdUsd` → dock（任何数量）
- 陈旧平仓：该方向仓位数 ≥ 2 且**最旧**仓位价格离开区间超过 `staleDistancePct` → dock 最旧
- 首仓：该侧 `balanceUsd ≥ minSideValueUsd` 且该方向 0 仓 → ship
- 二仓：该方向 1 仓（dock 后），距最新仓开仓 ≥ `positionMinIntervalS` 秒，且价格沿成交方向偏离最新仓区间 ≥ `priceDriftPct` → ship
- 区间：side='inch' → `[P, P×(1+w)]`；side='usdt' → `[P×(1−w), P]`；w 按 `balanceUsd` 取档位
- 资金：`tokenAmount` = 该侧钱包全额（共享资金）
- 操作上限：dock 优先，总数截断到 `maxActionsPerLoop`

- [ ] **Step 1: 写失败测试 tests/strategy.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { decide } from '../src/strategy';
import { loadConfig } from '../src/config';
import type { Position, SideState } from '../src/types';

const cfg = loadConfig({
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv);

const NOW = 1_700_000_000_000;
const P = 0.3; // 1INCH = 0.3 USDT

function pos(over: Partial<Position> = {}): Position {
  return {
    strategyHash: '0x' + 'ab'.repeat(32),
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/strategy.test.ts`
Expected: FAIL（`Cannot find module '../src/strategy'`）

- [ ] **Step 3: 实现 src/strategy.ts**

```ts
import type { Config } from './config';
import type { Decision, NewPosition, Position, Side, SideState } from './types';

/**
 * 核心决策纯函数：输入当前状态 → 输出要 dock/要 ship 的仓位。
 * 不依赖 RPC、钱包、SDK，全部参数注入，可完整单测。
 * 用户后期优化策略只改本文件。
 */

/** 按侧资金取区间宽度档位（widthTiersUsd 降序） */
function widthFor(cfg: Config, balanceUsd: number): number {
  for (const tier of cfg.widthTiersUsd) {
    if (balanceUsd >= tier.threshold) return tier.width;
  }
  return cfg.widthTiersUsd[cfg.widthTiersUsd.length - 1].width;
}

/** 价格沿成交方向穿出区间超过 driftPct（卖侧看上限，买侧看下限） */
function priceDriftedBeyond(price: number, p: Position, driftPct: number): boolean {
  if (p.side === 'inch') return price > p.upper * (1 + driftPct);
  return price < p.lower * (1 - driftPct);
}

/** 陈旧判定：价格离开区间超过 stalePct（上超上限或下破下限） */
function priceStaleBeyond(price: number, p: Position, stalePct: number): boolean {
  return price > p.upper * (1 + stalePct) || price < p.lower * (1 - stalePct);
}

/** 计算新仓位区间与资金（共享：全额虚拟分配） */
function buildNewPosition(cfg: Config, price: number, side: Side, tokenBalance: bigint, balanceUsd: number): NewPosition {
  const w = widthFor(cfg, balanceUsd);
  if (side === 'inch') {
    return { side, lower: price, upper: price * (1 + w), tokenAmount: tokenBalance };
  }
  return { side, lower: price * (1 - w), upper: price, tokenAmount: tokenBalance };
}

/** 对单个方向做决策 */
function planSide(
  cfg: Config,
  price: number,
  side: Side,
  state: SideState,
  nowMs: number,
): { docks: Position[]; ships: NewPosition[]; reasons: string[] } {
  const docks: Position[] = [];
  const ships: NewPosition[] = [];
  const reasons: string[] = [];
  const positions = state.positions; // 已按 openedAtMs 升序

  // 1) 空壳清理：剩余 < 阈值（任何数量）
  for (const p of positions) {
    if (p.remainingUsd < cfg.emptyPositionThresholdUsd) {
      docks.push(p);
      reasons.push(`${side} 侧仓位 ${p.strategyHash.slice(0, 12)}… 剩余 ${p.remainingUsd.toFixed(1)}U < ${cfg.emptyPositionThresholdUsd}U，dock 清理空壳`);
    }
  }
  const survivors = positions.filter((p) => !docks.includes(p));

  // 2) 陈旧平仓：≥2 仓且最旧仓价格离开区间 > staleDistancePct → dock 最旧
  if (survivors.length >= 2 && priceStaleBeyond(price, survivors[0], cfg.staleDistancePct)) {
    docks.push(survivors[0]);
    reasons.push(`${side} 侧 2 仓且最旧仓区间已偏离价格 ${(cfg.staleDistancePct * 100).toFixed(0)}% 以上，dock 最旧 ${survivors[0].strategyHash.slice(0, 12)}…`);
  }
  const afterDocks = positions.filter((p) => !docks.includes(p));

  // 3) 开仓：首仓 / 二仓滚动
  if (state.balanceUsd >= cfg.minSideValueUsd && afterDocks.length < cfg.maxPositionsPerSide) {
    let canOpen = false;
    let skipReason = '';
    if (afterDocks.length === 0) {
      canOpen = true; // 首仓：只要资金够
    } else {
      const latest = afterDocks[afterDocks.length - 1];
      const elapsedS = (nowMs - latest.openedAtMs) / 1000;
      if (elapsedS < cfg.positionMinIntervalS) {
        skipReason = `距最新仓开仓仅 ${elapsedS.toFixed(0)}s（< ${cfg.positionMinIntervalS}s）`;
      } else if (!priceDriftedBeyond(price, latest, cfg.priceDriftPct)) {
        skipReason = `价格未沿成交方向偏离最新仓区间 ${(cfg.priceDriftPct * 100).toFixed(3)}%`;
      } else {
        canOpen = true; // 二仓滚动
      }
    }
    if (canOpen) {
      const np = buildNewPosition(cfg, price, side, state.tokenBalance, state.balanceUsd);
      ships.push(np);
      const w = np.side === 'inch' ? np.upper / price - 1 : 1 - np.lower / price;
      reasons.push(
        `${side} 侧资金 ${state.balanceUsd.toFixed(0)}U ≥ ${cfg.minSideValueUsd}U（${afterDocks.length} 仓），开${afterDocks.length === 0 ? '首' : '二'}仓：区间 [${np.lower.toFixed(6)}, ${np.upper.toFixed(6)}]，宽度 ${(w * 100).toFixed(3)}%`,
      );
    } else if (state.balanceUsd >= cfg.minSideValueUsd) {
      reasons.push(`${side} 侧资金达标但暂不开仓：${skipReason}`);
    }
  }

  return { docks, ships, reasons };
}

/**
 * 一次循环的完整决策。
 * 操作上限：dock 优先（先到先得），总数截断到 maxActionsPerLoop，剩余推迟下一循环。
 */
export function decide(
  cfg: Config,
  price: number,
  inch: SideState,
  usdt: SideState,
  nowMs: number,
): Decision {
  const a = planSide(cfg, price, 'inch', inch, nowMs);
  const b = planSide(cfg, price, 'usdt', usdt, nowMs);

  let docks = [...a.docks, ...b.docks];
  let ships = [...a.ships, ...b.ships];
  const reasons = [...a.reasons, ...b.reasons];

  if (docks.length + ships.length > cfg.maxActionsPerLoop) {
    docks = docks.slice(0, cfg.maxActionsPerLoop);
    const slots = cfg.maxActionsPerLoop - docks.length;
    ships = ships.slice(0, slots);
    reasons.push(`本循环操作数超过上限 ${cfg.maxActionsPerLoop}，截断（dock 优先，剩余推迟下一循环）`);
  }

  return { docks, ships, reasons };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/strategy.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 核心决策纯函数（开仓/二仓滚动/空壳/陈旧/上限）"
git push
```

---

### Task 8: events.ts（仓位剩余余额对账）

**Files:**
- Create: `src/events.ts`
- Test: `tests/events.test.ts`

**Interfaces:**
- Consumes: `Position`（types.ts）、`AquaClient.getRemaining`（aqua-client.ts，Task 3）
- Produces: `refreshRemaining(aqua: AquaClient, positions: Position[]): Promise<Position[]>`——对每个仓位读剩余虚拟余额并更新 `remainingUsd`（换算成 U 需价格，故签名含 price）

最终签名：`refreshRemaining(aqua: AquaClient, positions: Position[], price: number, cfg: Config): Promise<Position[]>`

- [ ] **Step 1: 写失败测试 tests/events.test.ts**

```ts
import { describe, expect, it, vi } from 'vitest';
import { refreshRemaining } from '../src/events';
import { loadConfig } from '../src/config';
import type { AquaClient } from '../src/aqua-client';
import type { Position } from '../src/types';

const cfg = loadConfig({
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv);

function pos(over: Partial<Position> = {}): Position {
  return {
    strategyHash: '0x' + 'ab'.repeat(32),
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
    const p2 = pos({ strategyHash: '0x' + 'cd'.repeat(32), side: 'usdt', tokenAddress: cfg.tokenUsdt });
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/events.test.ts`
Expected: FAIL（`Cannot find module '../src/events'`）

- [ ] **Step 3: 实现 src/events.ts**

```ts
import type { AquaClient } from './aqua-client';
import type { Config } from './config';
import type { Position } from './types';

/**
 * 链上对账：把每个仓位的剩余虚拟余额刷新到本地表。
 * 依赖 Task 3 中 aqua-client.getRemaining 的实现方式
 * （链上只读查询，或按 SDK_NOTES.md 记录的事件累计方案）。
 * 单个仓位读取失败不阻断整体（该仓保留原值，下轮再试）。
 */
export async function refreshRemaining(
  aqua: AquaClient,
  positions: Position[],
  price: number,
  cfg: Config,
): Promise<Position[]> {
  const decimals = (side: Position['side']) =>
    side === 'inch' ? cfg.tokenInchDecimals : cfg.tokenUsdtDecimals;

  const results = await Promise.all(
    positions.map(async (p) => {
      try {
        const remaining = await aqua.getRemaining(p.strategyHash, p.tokenAddress);
        const usd = Number(remaining) / 10 ** decimals(p.side) * (p.side === 'inch' ? price : 1);
        return { ...p, remainingUsd: usd };
      } catch (e) {
        // 读失败：保留原值，但必须留痕（真钱安全）——静默的旧值可能掩盖
        // 已排空的仓位，导致空壳清理规则失效
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`仓位剩余余额读取失败（保留原值，下轮重试）: hash=${p.strategyHash} 原因=${reason}`);
        return p;
      }
    }),
  );
  return results;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/events.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 仓位剩余余额链上对账"
git push
```

---

### Task 9: executor.ts（ship/dock 执行、重试、紧急全平）

**Files:**
- Create: `src/executor.ts`
- Test: `tests/executor.test.ts`

**Interfaces:**
- Consumes: `AquaClient`/`TxRequest`（aqua-client.ts）、`Config`、`NewPosition`、`Position`（types.ts）、`Logger`（logger.ts）
- Produces: `Executor` 类：
  - `ship(pos: NewPosition): Promise<`0x${string}`>`——构建+广播+等回执，返回 strategyHash
  - `dock(strategyHash: `0x${string}`, tokenAddress: `0x${string}`): Promise<`0x${string}`>`——返回 txHash
  - `dockAll(positions: Position[]): Promise<void>`——best-effort 全平（熔断用）
  - `withRetry<T>(fn: () => Promise<T>, op: string): Promise<T>`——网络错误重试 2 次

- [ ] **Step 1: 写失败测试 tests/executor.test.ts**

```ts
import { describe, expect, it, vi } from 'vitest';
import { Executor } from '../src/executor';
import { loadConfig } from '../src/config';
import { Logger } from '../src/logger';
import type { AquaClient, TxRequest } from '../src/aqua-client';
import type { NewPosition, Position } from '../src/types';

const cfg = loadConfig({
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv);

const silentLogger = new Logger('error', 'logs');
const WALLET = '0x' + '22'.repeat(20) as `0x${string}`;

function makeNewPos(over: Partial<NewPosition> = {}): NewPosition {
  return { side: 'inch', lower: 0.3, upper: 0.30012, tokenAmount: 20000n * 10n ** 18n, ...over };
}
function makePos(over: Partial<Position> = {}): Position {
  return {
    strategyHash: '0x' + 'ab'.repeat(32),
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

const TX: TxRequest = { to: '0x' + '33'.repeat(20) as `0x${string}`, data: '0xdeadbeef', value: 0n };

function makeMocks() {
  const buildShip = vi.fn().mockResolvedValue({ tx: TX, strategyHash: '0x' + 'ab'.repeat(32) as `0x${string}` });
  const buildDock = vi.fn().mockResolvedValue(TX);
  const aqua = { buildShip, buildDock } as unknown as AquaClient;
  const sendTransaction = vi.fn().mockResolvedValue('0x' + 'aa'.repeat(32) as `0x${string}`);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' });
  const wallet = { account: { address: WALLET }, sendTransaction } as never;
  const publicClient = { waitForTransactionReceipt } as never;
  const exec = new Executor(aqua, wallet, publicClient, silentLogger, cfg);
  return { exec, buildShip, buildDock, sendTransaction, waitForTransactionReceipt };
}

describe('Executor', () => {
  it('ship 广播交易、等待回执并返回 strategyHash', async () => {
    const { exec, buildShip, sendTransaction, waitForTransactionReceipt } = makeMocks();
    const hash = await exec.ship(makeNewPos());
    expect(hash).toBe('0x' + 'ab'.repeat(32));
    expect(buildShip).toHaveBeenCalledWith(expect.objectContaining({ side: 'inch' }), WALLET);
    expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: TX.to, data: TX.data }));
    expect(waitForTransactionReceipt).toHaveBeenCalled();
  });

  it('dock 调用 buildDock 并广播', async () => {
    const { exec, buildDock } = makeMocks();
    const p = makePos();
    await exec.dock(p.strategyHash, p.tokenAddress);
    expect(buildDock).toHaveBeenCalledWith(p.strategyHash, cfg.tokenInch);
  });

  it('网络错误自动重试，2 次后仍失败则抛出', async () => {
    vi.useFakeTimers(); // 消除重试真实 sleep 的抖动风险（vitest 5s 默认超时误杀过）
    const { exec, buildShip, sendTransaction } = makeMocks();
    sendTransaction
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'));
    const p = exec.ship(makeNewPos());
    const assertion = expect(p).rejects.toThrow(/network/); // 先挂处理器，避免假时钟推进期间的 unhandled rejection
    await vi.runAllTimersAsync();
    await assertion;
    expect(sendTransaction).toHaveBeenCalledTimes(3); // 1 次 + 2 重试
    expect(buildShip).toHaveBeenCalledTimes(1); // 重试绝不重建 ship（随机 salt 幂等防线）
    vi.useRealTimers();
  });

  it('重试后成功（第 2 次成功）', async () => {
    vi.useFakeTimers();
    const { exec, buildShip, sendTransaction } = makeMocks();
    sendTransaction.mockRejectedValueOnce(new Error('network'));
    const p = exec.ship(makeNewPos());
    await vi.runAllTimersAsync();
    await p;
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(buildShip).toHaveBeenCalledTimes(1); // 重试绝不重建 ship（随机 salt 幂等防线）
    vi.useRealTimers();
  });

  it('回执 status=reverted 时 ship/dock 均拒绝（revert 不算成功，防幻影仓位）', async () => {
    vi.useFakeTimers();
    const { exec, waitForTransactionReceipt } = makeMocks();
    waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    const shipP = exec.ship(makeNewPos());
    const handledShip = shipP.catch((e) => e); // 先挂处理器，避免假时钟推进期间的 unhandled rejection
    await vi.runAllTimersAsync();
    const shipErr = await handledShip;
    expect(String(shipErr)).toMatch(/reverted/);
    expect(String(shipErr)).toContain('0x' + 'aa'.repeat(32)); // 错误信息含 tx hash
    const dockP = exec.dock(makePos().strategyHash, makePos().tokenAddress);
    const handledDock = dockP.catch((e) => e);
    await vi.runAllTimersAsync();
    const dockErr = await handledDock;
    expect(String(dockErr)).toMatch(/reverted/);
    vi.useRealTimers();
  });

  it('dockAll 逐个平仓，单个失败不影响其余（best-effort）', async () => {
    vi.useFakeTimers(); // 消除重试真实 sleep 的抖动风险
    const { exec, buildDock, sendTransaction } = makeMocks();
    let calls = 0;
    sendTransaction.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return '0x' + 'aa'.repeat(32); // 第 1 个仓位成功
      throw new Error('revert'); // 第 2 个仓位全部重试失败
    });
    const positions = [makePos(), makePos({ strategyHash: '0x' + 'cd'.repeat(32) })];
    const p = exec.dockAll(positions); // 不抛错
    await vi.runAllTimersAsync();
    await p;
    expect(buildDock).toHaveBeenCalledTimes(2);
    expect(sendTransaction).toHaveBeenCalledTimes(4); // 1 成功 + 3 次失败重试
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/executor.test.ts`
Expected: FAIL（`Cannot find module '../src/executor'`）

- [ ] **Step 3: 实现 src/executor.ts**

```ts
import type { PublicClient, WalletClient } from 'viem';
import type { AquaClient } from './aqua-client';
import type { Config } from './config';
import type { Logger } from './logger';
import type { NewPosition, Position } from './types';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 链上执行层：把决策变成真实交易（ship/dock）。
 * 职责：广播、等回执、网络错误重试；不做任何策略判断。
 * 熔断全平（dockAll）也在这里：best-effort，单个失败不阻断。
 */
export class Executor {
  constructor(
    private aqua: AquaClient,
    private wallet: WalletClient,
    private publicClient: PublicClient,
    private logger: Logger,
    private cfg: Config,
  ) {}

  /** 广播并等待回执；网络类错误重试 MAX_RETRIES 次 */
  async withRetry<T>(fn: () => Promise<T>, op: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        this.logger.warn(`${op} 失败（第 ${attempt + 1}/${MAX_RETRIES + 1} 次）: ${String(e)}`);
        if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
      }
    }
    throw lastErr;
  }

  private async send(tx: { to: `0x${string}`; data: `0x${string}`; value: bigint }): Promise<`0x${string}`> {
    const hash = await this.wallet.sendTransaction({
      account: this.wallet.account,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    // 回执 status 必须为 success：viem 的 waitForTransactionReceipt 对 revert 不抛错（仅超时/未找到/替换报错），
    // 不检查会把 revert 当成功——ship 会记下幻影仓位（资金锁定）、dock 会误删仓位
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`交易回执非成功（status=${receipt.status}）: ${hash}`);
    }
    return hash;
  }

  /** 开仓：构建 calldata → 广播 → 返回新仓位 strategyHash */
  async ship(pos: NewPosition): Promise<`0x${string}`> {
    const plan = await this.withRetry(
      () => this.aqua.buildShip(pos, this.wallet.account.address),
      `构建 ship（${pos.side}）`,
    );
    await this.withRetry(() => this.send(plan.tx), `广播 ship（${pos.side}）`);
    this.logger.info(`ship 成功: ${pos.side} 区间 [${pos.lower.toFixed(6)}, ${pos.upper.toFixed(6)}] hash=${plan.strategyHash}`);
    return plan.strategyHash;
  }

  /** 平仓：构建 calldata → 广播 → 返回 txHash */
  async dock(strategyHash: `0x${string}`, tokenAddress: `0x${string}`): Promise<`0x${string}`> {
    const tx = await this.withRetry(
      () => this.aqua.buildDock(strategyHash, tokenAddress),
      `构建 dock（${strategyHash.slice(0, 12)}…）`,
    );
    const hash = await this.withRetry(() => this.send(tx), `广播 dock（${strategyHash.slice(0, 12)}…）`);
    this.logger.info(`dock 成功: ${strategyHash}`);
    return hash;
  }

  /** 熔断全平：best-effort 逐个 dock，单个失败记录后继续 */
  async dockAll(positions: Position[]): Promise<void> {
    this.logger.warn(`熔断全平：共 ${positions.length} 个仓位`);
    for (const p of positions) {
      try {
        await this.dock(p.strategyHash, p.tokenAddress);
      } catch (e) {
        this.logger.error(`dockAll 失败（继续下一个）: ${p.strategyHash} — ${String(e)}`);
      }
    }
  }
}
```

注意：DRY_RUN 模式下 executor 不被调用（由 loop 层拦截），因此 executor 无需感知 dryRun。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/executor.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 执行层（ship/dock/重试/熔断全平）"
git push
```

---

### Task 10: loop.ts + main.ts（主循环、熔断、DRY_RUN、优雅退出）

**Files:**
- Create: `src/loop.ts`、`src/main.ts`
- Test: `tests/loop.test.ts`

**Interfaces:**
- Consumes: 全部既有模块（Config、Logger、PriceSource、PositionsStore、Executor、AquaClient、inventory、strategy、events）
- Produces: `LoopDeps` 接口、`runLoop(deps: LoopDeps): Promise<void>`；main.ts 装配与 SIGINT 处理

循环语义：
1. 取价 → 读余额 → 组装两侧状态 → `decide()` → 记录 reasons
2. 真实模式：先 dock 后 ship（按 Decision 顺序），dock 成功即从表移除，ship 成功即入表（remainingUsd 初值 = 分配估值）；随后 `refreshRemaining` 对账
3. DRY_RUN：不广播，按「假设执行成功」推进本地表（docks 移除；ships 以占位 hash `dry-<时间戳>-<side>` 入表），同样执行对账读链（只读，安全）
4. 每次迭代成功 → 失败计数清零；抛错 → 失败计数 +1；≥ maxConsecutiveFailures → `dockAll` + `process.exit(1)`（DRY_RUN 下只 log 不广播，然后 exit）
5. 每轮结束 sleep loopIntervalS；SIGINT 优雅退出（不主动 dock）

- [ ] **Step 1: 写失败测试 tests/loop.test.ts**

用假依赖（fake price source / fake aqua client / fake executor）测 runLoop 的一轮行为。为可测性，`runLoop` 接受 `sleep` 注入；测试用 `maxIterations` 之外的「首轮后抛哨兵」结束循环。

```ts
import { describe, expect, it, vi } from 'vitest';
import { runLoop, LoopDeps } from '../src/loop';
import { loadConfig } from '../src/config';
import { Logger } from '../src/logger';
import { PositionsStore } from '../src/positions';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PriceSource } from '../src/price/price-source';
import type { Position } from '../src/types';

const cfg = loadConfig({
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv);

const silentLogger = new Logger('error', 'logs');
const WALLET = '0x' + '22'.repeat(20) as `0x${string}`;

function fakePosition(over: Partial<Position> = {}): Position {
  return {
    strategyHash: '0x' + 'ab'.repeat(32),
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

function makeDeps(over: Partial<LoopDeps> = {}, throwAfterIteration = 1): LoopDeps & { iterations: number } {
  let iterations = 0;
  const store = new PositionsStore(join(mkdtempSync(join(tmpdir(), 'loop-')), 'positions.json'));
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
});
```

注意：loop 内 exit 后测试结束的语义——`process.exit` 被 spy 掉后循环继续走 sleep 抛哨兵。若实现用 `exit(1)` 前 `throw` 也行；实现必须保证 dockAll 恰被调用一次（见 Step 3 代码）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/loop.test.ts`
Expected: FAIL（`Cannot find module '../src/loop'`）

- [ ] **Step 3: 实现 src/loop.ts**

```ts
import type { PublicClient } from 'viem';
import type { AquaClient } from './aqua-client';
import type { Config } from './config';
import type { Executor } from './executor';
import { refreshRemaining } from './events';
import { fetchBalances, toSideStates } from './inventory';
import type { Logger } from './logger';
import { PositionsStore } from './positions';
import type { PriceSource } from './price/price-source';
import { decide } from './strategy';
import type { NewPosition, Position } from './types';

/** 循环依赖注入集合（便于测试替换任何部件） */
export interface LoopDeps {
  cfg: Config;
  walletAddress: `0x${string}`;
  logger: Logger;
  priceSource: PriceSource;
  publicClient: PublicClient;
  store: PositionsStore;
  executor: Executor;
  aqua: AquaClient;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tokenFor(cfg: Config, side: NewPosition['side']): `0x${string}` {
  return side === 'inch' ? cfg.tokenInch : cfg.tokenUsdt;
}

function estUsd(pos: NewPosition, price: number, cfg: Config): number {
  const decimals = pos.side === 'inch' ? cfg.tokenInchDecimals : cfg.tokenUsdtDecimals;
  const usd = Number(pos.tokenAmount) / 10 ** decimals * (pos.side === 'inch' ? price : 1);
  return usd;
}

/** 单次迭代：取价 → 余额 → 决策 → 执行 → 对账 → 持久化。异常向上抛给 runLoop 计失败。 */
async function oneIteration(deps: LoopDeps, nowMs: number): Promise<void> {
  const { cfg, logger, priceSource, publicClient, store, executor, aqua, walletAddress } = deps;

  const price = await priceSource.getPrice();
  const balances = await fetchBalances(publicClient, walletAddress, cfg);
  let positions = store.load();
  const { inch, usdt } = toSideStates(balances, price, positions, cfg);
  const decision = decide(cfg, price, inch, usdt, nowMs);

  for (const r of decision.reasons) logger.debug(`决策: ${r}`);
  logger.info(
    `价格=${price.toFixed(6)} 1INCH侧=${inch.balanceUsd.toFixed(0)}U(${inch.positions.length}仓) USDT侧=${usdt.balanceUsd.toFixed(0)}U(${usdt.positions.length}仓) → dock ${decision.docks.length} / ship ${decision.ships.length}`,
  );

  if (cfg.dryRun) {
    // 干跑：假设执行成功推进本地表；只打日志不广播
    for (const p of decision.docks) {
      logger.info(`[DRY_RUN] 将 dock ${p.strategyHash}`);
      positions = positions.filter((x) => x.strategyHash !== p.strategyHash);
    }
    for (const s of decision.ships) {
      const fakeHash = `dry-${nowMs}-${s.side}` as `0x${string}`;
      logger.info(`[DRY_RUN] 将 ship ${s.side} 区间 [${s.lower.toFixed(6)}, ${s.upper.toFixed(6)}]（hash=${fakeHash}）`);
      positions.push({
        strategyHash: fakeHash,
        side: s.side,
        tokenAddress: tokenFor(cfg, s.side),
        lower: s.lower,
        upper: s.upper,
        allocatedUsd: estUsd(s, price, cfg),
        remainingUsd: estUsd(s, price, cfg),
        openedAtMs: nowMs,
      });
    }
  } else {
    // 真实模式：先 dock 后 ship
    for (const p of decision.docks) {
      await executor.dock(p.strategyHash, p.tokenAddress);
      positions = positions.filter((x) => x.strategyHash !== p.strategyHash);
    }
    for (const s of decision.ships) {
      const strategyHash = await executor.ship(s);
      positions.push({
        strategyHash,
        side: s.side,
        tokenAddress: tokenFor(cfg, s.side),
        lower: s.lower,
        upper: s.upper,
        allocatedUsd: estUsd(s, price, cfg),
        remainingUsd: estUsd(s, price, cfg),
        openedAtMs: nowMs,
      });
    }
  }

  // 对账：刷新各仓位剩余余额（只读链上调用，干跑同样执行）
  positions = await refreshRemaining(aqua, positions, price, cfg);
  store.save(positions);
}

/** 主循环：熔断（连续失败 ≥ 阈值 → 全平 + exit(1)）与间隔 sleep */
export async function runLoop(deps: LoopDeps): Promise<void> {
  const { cfg, logger, store, executor } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  let failures = 0;

  while (true) {
    try {
      await oneIteration(deps, Date.now());
      failures = 0;
    } catch (e) {
      failures += 1;
      logger.error(`循环失败（连续 ${failures}/${cfg.maxConsecutiveFailures}）: ${String(e)}`);
      if (failures >= cfg.maxConsecutiveFailures) {
        logger.error('熔断触发：dock 全部自己的仓位后退出');
        if (cfg.dryRun) {
          for (const p of store.load()) logger.info(`[DRY_RUN] 熔断将 dock ${p.strategyHash}`);
        } else {
          await executor.dockAll(store.load());
        }
        process.exit(1);
      }
    }
    await sleep(cfg.loopIntervalS * 1000);
  }
}
```

- [ ] **Step 4: 实现 src/main.ts**

```ts
import 'dotenv/config';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createAquaClient } from './aqua-client';
import { loadConfig } from './config';
import { Executor } from './executor';
import { Logger } from './logger';
import { PositionsStore } from './positions';
import { SpotPriceApi } from './price/spot-price-api';
import { runLoop } from './loop';

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const logger = new Logger('info');

  const account = privateKeyToAccount(cfg.privateKey);
  const publicClient = createPublicClient({ chain: undefined, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, chain: undefined, transport: http(cfg.rpcUrl) });
  const aqua = await createAquaClient(cfg);
  const priceSource = new SpotPriceApi({
    apiKey: cfg.apiKey1inch,
    tokenInch: cfg.tokenInch,
    tokenUsdt: cfg.tokenUsdt,
    chainId: cfg.chainId,
  });

  const deps = {
    cfg,
    walletAddress: account.address,
    logger,
    priceSource,
    publicClient,
    store: new PositionsStore('data/positions.json'),
    executor: new Executor(aqua, wallet, publicClient, logger, cfg),
    aqua,
  };

  logger.info(`aqua-lp-bot 启动：链=${cfg.chainId} 钱包=${account.address} DRY_RUN=${cfg.dryRun} 循环间隔=${cfg.loopIntervalS}s`);

  // Ctrl+C 优雅退出：不主动 dock（避免误关仓）
  process.on('SIGINT', () => {
    logger.info('收到 SIGINT，优雅退出（不主动 dock）');
    process.exit(0);
  });

  await runLoop(deps);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
```

注意：viem `createPublicClient({ chain: undefined, transport })` 的类型在部分版本会抱怨 chain 必填——若 typecheck 报错，改为传入 `chain: mainnet`（`import { mainnet } from 'viem/chains'`），两步都试一下选能通过的方式。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- tests/loop.test.ts` → PASS；`npm run typecheck` → 无错误

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: 主循环、熔断、DRY_RUN 与优雅退出"
git push
```

---

### Task 11: 冒烟脚本 + README + 收尾

**Files:**
- Create: `scripts/smoke-test.ts`、`README.md`

**Interfaces:**
- Consumes: 全部模块（验证真实上链闭环）

- [ ] **Step 1: 实现 scripts/smoke-test.ts**

用途：用显式参数在小资金测试钱包上验证 ship → 事件确认 → dock 闭环（与策略阈值无关）。

```ts
/**
 * 冒烟测试：小仓位验证真实上链闭环。
 *
 * 用法（先准备测试钱包：约 100U，1INCH/USDT 各半，.env 指向该钱包）：
 *   npm run smoke -- ship --side inch --amount 50      # 挂 50U 卖 1INCH 仓位
 *   npm run smoke -- ship --side usdt --amount 50      # 挂 50U 卖 USDT 仓位
 *   npm run smoke -- dock --strategy-hash 0x...        # 平掉指定仓位
 *   npm run smoke -- dock-all                          # 平掉本地表全部仓位
 */
import 'dotenv/config';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createAquaClient } from '../src/aqua-client.js';
import { loadConfig } from '../src/config.js';
import { Executor } from '../src/executor.js';
import { Logger } from '../src/logger.js';
import { PositionsStore } from '../src/positions.js';
import { SpotPriceApi } from '../src/price/spot-price-api.js';

function usage(): never {
  console.error('用法: npm run smoke -- ship --side inch|usdt --amount <U> | dock --strategy-hash 0x.. | dock-all');
  process.exit(2);
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const logger = new Logger('debug');
  const [cmd, ...rest] = process.argv.slice(2);

  const account = privateKeyToAccount(cfg.privateKey);
  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, transport: http(cfg.rpcUrl) });
  const aqua = await createAquaClient(cfg);
  const executor = new Executor(aqua, wallet, publicClient, logger, cfg);
  const price = await new SpotPriceApi({
    apiKey: cfg.apiKey1inch,
    tokenInch: cfg.tokenInch,
    tokenUsdt: cfg.tokenUsdt,
    chainId: cfg.chainId,
  }).getPrice();
  logger.info(`当前价格: ${price.toFixed(6)} USDT/1INCH，钱包: ${account.address}`);

  if (cmd === 'ship') {
    const side = rest[rest.indexOf('--side') + 1];
    const amountUsd = Number(rest[rest.indexOf('--amount') + 1]);
    if ((side !== 'inch' && side !== 'usdt') || !Number.isFinite(amountUsd)) usage();

    const decimals = side === 'inch' ? cfg.tokenInchDecimals : cfg.tokenUsdtDecimals;
    const tokenAmount = BigInt(Math.round(amountUsd / (side === 'inch' ? price : 1) * 10 ** decimals));
    const w = amountUsd >= 9000 ? 0.0006 : 0.0004; // 与 strategy 同档位规则
    const lower = side === 'inch' ? price : price * (1 - w);
    const upper = side === 'inch' ? price * (1 + w) : price;
    logger.info(`准备 ship：${side} 侧 ${amountUsd}U，区间 [${lower.toFixed(6)}, ${upper.toFixed(6)}]`);
    const hash = await executor.ship({ side, lower, upper, tokenAmount });
    logger.info(`✅ ship 完成，strategyHash=${hash}`);
  } else if (cmd === 'dock') {
    const hash = rest[rest.indexOf('--strategy-hash') + 1] as `0x${string}`;
    if (!hash) usage();
    // dock 需要知道仓位对应的代币：从本地仓位表反查
    const found = new PositionsStore('data/positions.json').load().find((p) => p.strategyHash === hash);
    if (!found) {
      logger.error(`本地仓位表找不到 ${hash}，拒绝 dock`);
      process.exit(1);
    }
    const tx = await executor.dock(found.strategyHash, found.tokenAddress);
    logger.info(`✅ dock 完成，tx=${tx}`);
  } else if (cmd === 'dock-all') {
    const positions = new PositionsStore('data/positions.json').load();
    await executor.dockAll(positions);
    logger.info('✅ dock-all 完成');
  } else {
    usage();
  }
}

main().catch((e) => {
  console.error('冒烟失败:', e);
  process.exit(1);
});
```

- [ ] **Step 2: 写 README.md**

包含：项目简介、原理图（策略规则表）、快速开始（.env 配置、key 申请链接、npm install）、运行方式（`npm run dev` / `npm start` / `DRY_RUN=true` 干跑）、冒烟测试用法、参数表（全部 env 键与默认值）、安全须知（私钥/白名单/熔断）、目录结构说明、测试命令。

- [ ] **Step 3: 全量验证**

Run: `npm test`（全部 PASS）、`npm run typecheck`（无错误）、`npm run build`（dist 生成成功）

- [ ] **Step 4: 提交并打 tag**

```bash
git add -A && git commit -m "feat: 冒烟脚本与 README，v0.1 收尾"
git push
git tag v0.1.0 && git push --tags
```

---

## Self-Review 记录

**Spec 覆盖核对：**
- 取价/估值/决策/执行/对账/持久化 → Task 5/6/7/9/8/4 ✅
- 开仓规则（首仓/二仓间隔+偏离/档位/方向/共享资金）→ Task 7 ✅
- 平仓规则（陈旧最旧先平/空壳 100U）→ Task 7 ✅
- 熔断（连续 3 失败 → 全平 → exit 1）→ Task 10 ✅
- 操作上限（dock 优先截断）→ Task 7 ✅
- DRY_RUN（假设执行推进、不广播）→ Task 10 ✅
- 白名单（只 dock 本地表内 hash）→ 天然满足：executor.dock 只被传入表内仓位；dockAll 只吃 store.load() ✅
- 冒烟脚本（小仓位闭环、不依赖策略阈值）→ Task 11 ✅
- 无部署/TG、日志文件 → Task 1（logger）✅
- Mac 本地运行 → `npm run dev` / `npm start` ✅

**Placeholder 扫描：** Task 3（spike）为有意设计——探索真实 SDK 签名并落档 SDK_NOTES.md，其余任务均含完整代码；无 TBD/TODO。

**类型一致性：** `Side`、`Position`、`NewPosition`、`SideState`、`Decision`（Task 1 定义）→ Task 4/5/6/7/8/9/10/11 引用一致；`AquaClient.buildShip(pos, walletAddress)`、`buildDock(strategyHash, tokenAddress)`、`getRemaining(strategyHash, tokenAddress)`（Task 3 定义）→ Task 8/9 调用一致；`Executor.ship/dock/dockAll`（Task 9 定义）→ Task 10/11 调用一致；`SpotPriceApi` 构造器 `{apiKey, tokenInch, tokenUsdt, chainId}`（Task 5 定义）→ Task 10/11 调用一致。Task 3 若发现 `getRemaining` 需改为事件方案，需同步改 Task 8 的 aqua 调用——已在 Task 3 Step 3 注明。
