# SDK_NOTES — 1inch Aqua SDK 探索笔记（Task 3）

> 记录 aqua-lp-bot 对 `@1inch/aqua-sdk` 与 `@1inch/swap-vm-sdk` 的真实 API 探索结论。
> 本文件是 executor / events 任务实现与后期接手的唯一参考资料。
> 所有函数签名均从已安装版本的 `.d.ts` 原样复制（未凭记忆），实测结论标注「实测」。

- 安装版本：`@1inch/aqua-sdk@0.3.0`、`@1inch/swap-vm-sdk@0.4.0`、`@1inch/sdk-core@0.1.2`（三个包共用同一份 hoisted 的 sdk-core）
- 探索日期：2026-08-18
- 官方文档参考：
  - https://business.1inch.com/portal/documentation/aqua/getting-started/strategy-template
  - https://business.1inch.com/portal/documentation/sdks/aqua-sdk
  - 合约源码：https://github.com/1inch/aqua-protocol (Aqua.sol)、https://github.com/1inch/swap-vm (XYCConcentrate.sol / SwapVM.sol)

## 0. 协议模型（先理解这个，后面都顺了）

- **ship**：maker 把「策略程序字节 `strategy` + 各 token 数量」登记到注册表合约（Aqua registry）。**ship 不转账**——资金留在 maker 钱包，合约只记账（虚拟余额 virtual balance）。
- **strategy 字节** = `abi.encode(Order{ maker, traits, data })`，其中 `data` = SwapVM 程序字节（program bytes），`traits` 为打包的 `uint256` 位域。
- **strategyHash** = `keccak256(strategy 字节)`（与 amounts/tokens 无关）。链上 ship 会返回它，离线也能提前算（SDK 提供）。
- **app**：执行策略的应用合约地址，本项目 = `AquaSwapVMRouter`（SwapVM 路由器）。ship/dock/push/pull 都要带 app。
- **dock**：结束策略，要求 tokens 列表与 ship 时登记的 tokensCount 完全一致（否则 `DockingShouldCloseAllTokens`）。dock 会把 tokensCount 置为 `0xff`，此后同一 strategyHash 再 ship 会因 `StrategiesMustBeImmutable` revert——**同一个 hash 只能用一次，包括 dock 之后**。
- **push/pull**：结算/追加虚拟余额（Aqua.pull 会从 maker 钱包真实转账到 taker）。
- 金额单位：**一律原生单位（native units，bigint）**。SwapVM 内 `balances = AQUA.safeBalances` 原始值，不做 1e18 归一化（实测读 SwapVM.sol 源码确认）。

## Q1. `ship()` 的精确入参/出参

SDK 类型（`node_modules/@1inch/aqua-sdk/dist/aqua-protocol-contract/types.d.ts`）：

```ts
export type ShipArgs = {
    app: Address;
    strategy: HexString;
    amountsAndTokens: AmountsAndTokens[];
};
export type AmountsAndTokens = {
    amount: bigint;
    token: Address;
};
```

构造交易的类方法（`aqua-protocol-contract.d.ts`）：

```ts
export declare class AquaProtocolContract {
    readonly address: Address;
    constructor(address: Address);
    static encodeShipCallData(args: ShipArgs): HexString;
    static encodeDockCallData(args: DockArgs): HexString;
    static buildShipTx(contractAddress: Address, params: ShipArgs): CallInfo;
    static buildDockTx(contractAddress: Address, params: DockArgs): CallInfo;
    static calculateStrategyHash(strategy: HexString): HexString;
    ship(params: ShipArgs): CallInfo;
    dock(params: DockArgs): CallInfo;
}
```

`CallInfo`（`@1inch/sdk-core/dist/types/tx.d.ts`）——返回的 `{to, data, value}` 字段名即如此：

```ts
export type CallInfo = {
    to: Hex;
    data: Hex;
    value: bigint;
};
```

- 链上 ABI（`abi/Aqua.abi.d.ts`）：

```ts
{ type: "function"; name: "ship";
  inputs: [ {name:"app"; type:"address"}, {name:"strategy"; type:"bytes"},
            {name:"tokens"; type:"address[]"}, {name:"amounts"; type:"uint256[]"} ];
  outputs: [{name:"strategyHash"; type:"bytes32"}]; stateMutability: "nonpayable" }
```

- `amountsAndTokens` 数组与链上 `tokens[]` / `amounts[]` 一一对应；`amount` 用原生单位 `bigint`（1INCH=1e18，USDT=1e6）。
- 实测：`buildShipTx` 返回 `{ to: 注册表地址, value: 0n, data: 548 字节 }`；用 viem `decodeFunctionData` 可完整回解出 `ship(app=router, strategy, tokens=[1INCH], amounts=[1000e18])`。

## Q2. `dock()` 的精确入参

SDK 类型（`types.d.ts`）：

```ts
export type DockArgs = {
    app: Address;
    /**
     *  should be as keccak256(strategy)
     */
    strategyHash: HexString;
    tokens: Address[];
};
```

- **`tokens` 必传**，且必须与 ship 时登记的 tokensCount 完全一致——链上 `dock` 校验 `tokens.length == tokensCount`，否则 revert `DockingShouldCloseAllTokens(app, strategyHash)`（实测读 Aqua.sol 源码确认）。
- 链上 ABI：`dock(address app, bytes32 strategyHash, address[] tokens)`（nonpayable，无返回）。
- 单边仓位（本 bot）tokens 数组只有一个元素（side 对应的 token）。

## Q3. `calculateStrategyHash` 的入参

```ts
static calculateStrategyHash(strategy: HexString): HexString;
```

- 入参只有 **strategy 字节**（`HexString`，即 `order.encode()` 的结果），**不含 amounts/tokens**。
- 实测三方一致（同一个样例 strategy）：
  - `AquaProtocolContract.calculateStrategyHash(strategy) == Order.hash()`（Aqua 模式下 `hash()` = `keccak256(encode())`，见 `order.d.ts` 注释）
  - `== viem.keccak256(strategy)`
- **ship 后新仓位的 strategyHash = 此预测值**：链上 ship 的返回值就是它。因此 buildShip 可离线算出 strategyHash，无需等交易回执。

## Q4. 窄区间单边卖 1INCH 仓位程序的构造（核心）

### 4.1 策略构造类（`swap-vm/strategies/aqua-xyc-amm-strategy.d.ts`）

```ts
export declare class AquaXYCAmmStrategy extends AquaAMMStrategy {
    readonly xycConcentrateArgs?: concentrate.ConcentrateGrowLiquidity2DArgs;
    constructor(xycConcentrateArgs?: concentrate.ConcentrateGrowLiquidity2DArgs);
    static new(): AquaXYCAmmStrategy;
    static newConcentrate(prices: ConcentrateRawPrices | ConcentrateSqrtPrices): AquaXYCAmmStrategy;
    build(): SwapVmProgram;
}
```

价格参数类型（`strategies/types.d.ts`）：

```ts
export type ConcentrateSqrtPrices = {
    sqrtPriceMin: bigint;
    sqrtPriceMax: bigint;
};
export type ConcentrateRawPrices = {
    rawPriceMin: bigint;
    rawPriceMax: bigint;
};
```

基类（`aqua-amm-strategy.d.ts`）：

```ts
export declare abstract class AquaAMMStrategy {
    feeBpsIn?: number;
    decayPeriod?: bigint;
    protocolFee?: { bps: number; receiver: Address; };
    accessToken?: Address;
    salt?: bigint;
    protected constructor();
    withProtocolFee(bps: number, receiver: Address): this;
    withDecayPeriod(decayPeriod: bigint): this;
    withFeeTokenIn(bps: number): this;
    withTxOriginAccessToken(token: Address): this;
    withSalt(salt: bigint): this;
}
```

### 4.2 精度格式：sqrtPrice（1e18 定点），不是裸人类价格

指令参数类（`instructions/concentrate/concentrate-grow-liquidity-2d-args.d.ts`）：

```ts
export declare const ONE_E18: bigint;
/**
 * Arguments for concentrateGrowLiquidity2D instruction
 * Contract encodes sqrtPriceMin and sqrtPriceMax (2 × uint256, 64 bytes)
 * P = tokenGt/tokenLt; sqrt(P) in 1e18 fixed-point
 * @see https://github.com/1inch/swap-vm/blob/main/src/instructions/XYCConcentrate.sol#L172
 **/
export declare class ConcentrateGrowLiquidity2DArgs implements IArgsData {
    readonly sqrtPriceMin: bigint;
    readonly sqrtPriceMax: bigint;
    static readonly CODER: IArgsCoder<ConcentrateGrowLiquidity2DArgs>;
    constructor(sqrtPriceMin: bigint, sqrtPriceMax: bigint);
    static fromSqrtPrices(sqrtPriceMin: bigint, sqrtPriceMax: bigint): ConcentrateGrowLiquidity2DArgs;
    /**
     * Build args from raw prices P_min, P_max (1e18 fixed-point).
     * Computes sqrtPrice = sqrt(P * 1e18) so that (sqrtPrice/1e18)^2 = P/1e18.
     **/
    static fromRawPrices(rawPriceMin: bigint, rawPriceMax: bigint): ConcentrateGrowLiquidity2DArgs;
    static decode(data: HexString): ConcentrateGrowLiquidity2DArgs;
    toJSON(): Record<string, unknown>;
}
```

- 链上 XYCConcentrate.sol 测试注释的原话：`sqrtP = sqrt(price * 1e18)`，price 为 1e18 定点。**区间上下限必须 scale 成 1e18 定点 sqrt 价格**（`sqrtPriceMin < sqrtPriceMax`），不能直接传人类价格。
- 推荐做法：用 SDK 的 `Price.fromHuman()` 处理小数位（不必手写 scale，它内部处理 decimals 换算）：

```ts
// instructions/concentrate/price/price.d.ts（节选）
export declare class Price {
    /**
     * Fixed-point sqrt price as used on-chain (`sqrt(P * 1e18)`).
     */
    static fromSqrt(price: bigint, pair: { tokenA: PriceToken; tokenB: PriceToken; }): Price;
    /**
     * Human decimal string for **quote per 1 base**`.
     */
    static fromHuman(price: string, pair: PricePair): Price;
    toRaw(): bigint;   // 原始价格 P，1e18 定点 ((sqrtP^2)/1e18)
    toSqrt(): bigint;  // 链上用的 sqrt 价格，1e18 定点
}
```

```ts
// price/types.d.ts
export type PriceToken = { address: Address; decimals: bigint; };
export type PricePair = { quoteToken: PriceToken; baseToken: PriceToken; };
```

### 4.3 本项目的价格约定（已验证）

- 项目价格 P = **USDT per 1INCH**（`src/types.ts` 的 lower/upper 都是这个口径）。
- 地址序：1INCH `0x1111...C302` < USDT `0xdAC1...1ec7`（实测 `INCH.lt(USDT) == true`）→ **tokenLt = 1INCH，tokenGt = USDT**。
- 合约 `P = tokenGt/tokenLt` = USDT/1INCH = **恰好就是项目的 P**，方向一致，无需翻转。
- `Price.fromHuman(String(p), { quoteToken: {address: USDT, decimals: 6n}, baseToken: {address: 1INCH, decimals: 18n} }).toSqrt()` 实测（USDT 报价、1INCH 为 base）：

  | 人类价格（USDT/1INCH） | toSqrt() 实测输出（已安装 SDK） |
  |---|---|
  | 0.2 | 447213595499 |
  | 0.20008 | 447303029276 |
  | 0.25 | 500000000000 |
  | 0.3 | 547722557505 |

  口径：实际编码 = `sqrt(价格 × 10^(base+quote decimals))`（本对 0.2 × 10^24 = 2e23 → sqrt ≈ 4.47e11，即 ×1e12 量级）。
  ⚠️ 本表早先版本误记成 ×1e21 量级（如 0.2 → 447213595499957939281），系记录口径错误；
  以本表与 `tests/aqua-client.test.ts` 的硬编码回归锚（生产同构 PAIR 实测）为准。

  升序保持（0.2→0.3 的 sqrt 也升序），因为 quote（USDT）恰为 tokenGt。
- 注意：若 quote < base 的对（如 USDC/WETH 用 USDC 报价），`PriceRange.new` 会自动 swap min/max 保证 `sqrtPriceMin < sqrtPriceMax`（SDK 行为）；本项目对不受影响，但别假设 SDK 不排序。

### 4.4 单边挂单的区间方向（用 SDK 数学函数实测验证）

`instructions/concentrate` 导出的数学函数（`concentrate-liquidity-math.d.ts`，mirror 链上 XYCConcentrate.sol）：

```ts
export declare function computeLiquidityAndPrice(balanceLt: bigint, balanceGt: bigint, sqrtPriceMin: bigint, sqrtPriceMax: bigint): { liquidity: bigint; sqrtPriceSpot: bigint; };
export declare function computeBalances(targetL: bigint, sqrtPspot: bigint, sqrtPmin: bigint, sqrtPmax: bigint): { bLt: bigint; bGt: bigint; };
export declare function computeLiquidityFromAmounts(availableLt: bigint, availableGt: bigint, sqrtPspot: bigint, sqrtPmin: bigint, sqrtPmax: bigint): { targetL: bigint; actualLt: bigint; actualGt: bigint; };
```

实测结论（与设计文档一致）：
- 只持 **tokenLt（1INCH）** 时，隐含 spot 被钉在**区间下界**，P 从下往上穿过区间时卖出 1INCH → `side='inch'` 区间为 `[P, P(1+w)]`。
- 只持 **tokenGt（USDT）** 时，隐含 spot 被钉在**区间上界**，P 从上往下穿过区间时卖出 USDT → `side='usdt'` 区间为 `[P(1-w), P]`。

### 4.5 Order 编码与 salt

```ts
// swap-vm/order.d.ts（节选）
export declare class Order {
    readonly maker: Address;
    readonly traits: MakerTraits;
    readonly program: SwapVmProgram;
    static new(params: DataFor<Order>): Order;
    static decode(encoded: HexString): Order;
    hash(domain?: {...}): HexString;  // Aqua 模式 = keccak256(encode())，忽略 domain
    encode(): HexString;
    build(): BuiltOrder;
}
```

```ts
// maker-traits.d.ts（节选）
export declare class MakerTraits {
    static new(data: DataFor<MakerTraits>): MakerTraits;
    static default(): MakerTraits;  // useAquaInsteadOfSignature=true，其余默认
}
```

构造流程（本项目 buildShip 用）：

```ts
const strategyObj = AquaXYCAmmStrategy
  .newConcentrate({ sqrtPriceMin: lo, sqrtPriceMax: hi })
  .withSalt(salt);                        // 见下方「必须加 salt」
const program = strategyObj.build();
const order = Order.new({
  maker: new Address(walletAddress),
  program,
  traits: MakerTraits.default(),          // Aqua 模式（无签名）
});
const strategy = order.encode();          // = abi.encode(Order)
const strategyHash = AquaProtocolContract.calculateStrategyHash(strategy);
```

- 实测 program 字节结构：`0x12 40 <sqrtPriceMin 32B> <sqrtPriceMax 32B> 11 00 14 08 <salt 8B>`，共 78 字节（concentrateGrowLiquidity2D opcode `0x12` + 64 字节参数 + xycSwapXD `0x1100` + salt opcode `0x14` + 8 字节参数）。salt 参数是 **8 字节**。
- **必须每次 buildShip 加随机 salt**：strategy 字节相同 → strategyHash 相同 → 第二次 ship 同 hash 直接 revert（`StrategiesMustBeImmutable`，dock 后同样永久占用）。
- **salt 宽度限制（实测踩坑）**：SDK 的 `SaltArgs` 只接受 uint64（`assert(salt >= 0n && salt <= UINT_64_MAX)`，coder 用 `addUint64` 编码 8 字节）——传 256 位随机数会直接 throw `Invalid salt value`。本项目实现用 `node:crypto` 的 `randomBytes(8)` 生成 64 位随机 salt（2^64 空间对本 bot 足够）。

## Q5. 事件解码器（Shipped/Docked/Pushed/Pulled）

四个事件类均存在，全部带 `static TOPIC` 与 `static fromLog(log: LogLike): XxxEvent`（内部用 viem `decodeEventLog` 对着 `AQUA_ABI` 解码）：

```ts
// shipped-event.d.ts
declare class ShippedEvent {
    readonly maker: Address;
    readonly app: Address;
    readonly strategyHash: HexString;
    readonly strategy: HexString;
    static TOPIC: HexString;
    constructor(maker: Address, app: Address, strategyHash: HexString, strategy: HexString);
    static fromLog(log: LogLike): ShippedEvent;
}
```

```ts
// docked-event.d.ts
declare class DockedEvent {
    readonly maker: Address;
    readonly app: Address;
    readonly strategyHash: HexString;
    static TOPIC: HexString;
    constructor(maker: Address, app: Address, strategyHash: HexString);
    static fromLog(log: LogLike): DockedEvent;
}
```

```ts
// pulled-event.d.ts
declare class PulledEvent {
    readonly maker: Address;
    readonly app: Address;
    readonly strategyHash: HexString;
    readonly token: Address;
    readonly amount: bigint;      // ← 带数量
    static TOPIC: HexString;
    constructor(maker: Address, app: Address, strategyHash: HexString, token: Address, amount: bigint);
    static fromLog(log: LogLike): PulledEvent;
}
```

```ts
// pushed-event.d.ts
declare class PushedEvent {
    readonly maker: Address;
    readonly app: Address;
    readonly strategyHash: HexString;
    readonly token: Address;
    readonly amount: bigint;      // ← 带数量
    static TOPIC: HexString;
    constructor(maker: Address, app: Address, strategyHash: HexString, token: Address, amount: bigint);
    static fromLog(log: LogLike): PushedEvent;
}
```

`LogLike`（`@1inch/sdk-core/dist/types/log.d.ts`）：

```ts
export type LogLike = {
    data: Hex;
    topics: [signature: Hex, ...Hex[]] | [];
};
```

topic0 实测值（`TOPIC.toString()`）：

| 事件 | topic0 |
|---|---|
| Shipped | `0xdc3622e06fb145651f567d421c9ef261d71d43e3778b761907bc0d70d42e52b0` |
| Docked | `0xd173a1d140c154eb1ce9298d251d5eb8c4089cc2d16e70f1067bdc810c6fe004` |
| Pulled | `0x3ad61047071575417c75e3311e5d46ff042e292b5dd8769ff18b4b254098ca7a` |
| Pushed | `0x3f18354abbd5306dd1665c2c90f614a4559e39dd620d04fbe5458e613b6588f3` |
| （SwapVM 的）Swapped | `0x54bc5c027d15d7aa8ae083f994ab4411d2f223291672ecd3a344f3d92dcaf8b2` |

- 实测：四个 `fromLog` 用合成 log（viem `encodeEventTopics` + `encodeAbiParameters` 构造）全部解码成功，`PushedEvent/PulledEvent.amount` 正确。
- 注意：Shipped/Docked/Pulled/Pushed 的参数字段**全部非 indexed**（都在 data 里），解析时不需要 topics 下标。

## Q6. 剩余虚拟余额的读取

链上存在只读函数 `rawBalances`（`abi/Aqua.abi.d.ts`）：

```ts
{ type: "function"; name: "rawBalances";
  inputs: [ {name:"maker"; type:"address"}, {name:"app"; type:"address"},
            {name:"strategyHash"; type:"bytes32"}, {name:"token"; type:"address"} ];
  outputs: [ {name:"balance"; type:"uint248"}, {name:"tokensCount"; type:"uint8"} ];
  stateMutability: "view" }
```

- selector 实测：`0x6d58b4cc`。
- 语义（实测读 Aqua.sol 源码）：`balance` = 该 (maker, app, strategyHash, token) 的虚拟余额（ship 登记、push/pull 增减）；`tokensCount` = 本策略登记 token 数，dock 后置 `0xff`。
- **getRemaining 直接用它**：`viem.readContract({ abi: AQUA_ABI, functionName: 'rawBalances', args: [maker, router, strategyHash, token] })` → 取 `balance`。不需要事件累计。
- 另有 `safeBalances(maker, app, strategyHash, token0, token1) view returns (uint256 balance0, uint256 balance1)`：要求两个 token 都处于 active 状态，否则 revert `SafeBalancesForTokenNotInActiveStrategy`。单边仓位对账用 `rawBalances` 即可。

## Q7. `AQUA_CONTRACT_ADDRESSES` 的导出形态

```ts
// aqua-sdk/dist/aqua-protocol-contract/constants.d.ts
export declare const AQUA_CONTRACT_ADDRESSES: Record<NetworkEnum, Address>;
```

```ts
// swap-vm-sdk/dist/swap-vm-contract/constants.d.ts
export declare const AQUA_SWAP_VM_CONTRACT_ADDRESSES: Record<NetworkEnum, Address>;
```

```ts
// @1inch/sdk-core/dist/types/chain.d.ts
export declare enum NetworkEnum {
    ETHEREUM = 1,
    POLYGON = 137,
    ZKSYNC = 324,
    BINANCE = 56,
    ARBITRUM = 42161,
    AVALANCHE = 43114,
    OPTIMISM = 10,
    GNOSIS = 100,
    COINBASE = 8453,
    LINEA = 59144,
    SONIC = 146,
    UNICHAIN = 130
}
```

- 索引键 = 链 ID 数字（`AQUA_CONTRACT_ADDRESSES[1]` 即以太坊）。
- 实测：**所有 12 条链的 Aqua 注册表地址相同**：`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`。
- **所有链的 AquaSwapVMRouter 地址相同**：`0x111111338c5091e8440b67b168bae16a668ac0de`（旧部署 `0x1111113db0e0ef9d0e3a50d5f094a3a57a26c0de` 已废弃，SDK 常量指向新地址）。
- SDK 常量返回 `Address` 实例（构造时校验 `isAddress` 并转小写），用 `.toString()` 得到 `0x` 字符串。

## 8. 其他实测结论与坑

1. **金额一律原生单位**：ship 的 `amount`、事件的 `amount`、rawBalances 的 `balance` 都是原生单位（1INCH=1e18、USDT=1e6），与项目 `NewPosition.tokenAmount` 一致。
2. **Address/HexString 包装类**：
   ```ts
   // sdk-core/dist/domains/address.d.ts（节选）
   export declare class Address {
       static NATIVE_CURRENCY: Address;
       static ZERO_ADDRESS: Address;
       constructor(val: string);   // 校验 isAddress，内部转小写
       toString(): Hex;
       equal(other: Address): boolean;
       lt(other: Address): boolean;
       gt(other: Address): boolean;
   }
   ```
   ```ts
   // sdk-core/dist/domains/hex-string.d.ts（节选）
   export declare class HexString {
       constructor(hex: string, name?: string);
       toBigInt(): bigint;
       toString(): Hex;
       equal(other: HexString): boolean;
   }
   ```
   凡 SDK 入参类型为 `Address`/`HexString` 的地方都要 `new Address(x)` / `new HexString(x)` 包一层。
3. **`Price` 不是顶层导出**：`import { Price } from '@1inch/swap-vm-sdk'` 会报「does not provide an export named 'Price'」——正确路径是 `import { instructions } from '@1inch/swap-vm-sdk'; instructions.concentrate.Price`（`swap-vm/index.d.ts` 只 `export * as instructions`）。
4. **运行打包坑（重要，生产运行前必须解决）**：纯 Node ESM 直接跑会挂——
   ```
   Error: Cannot find module '@1inch/byte-utils/dist/constants' imported from .../node_modules/@1inch/swap-vm-sdk/dist/index.mjs
   ```
   `@1inch/swap-vm-sdk` 打包产物内部有**无扩展名的相对 import**，而 `@1inch/byte-utils` 没有 exports map，Node 的严格 ESM 解析直接失败。
   - `tsx`（esbuild 解析）能正常解析。
   - **vitest 默认同样会挂**（外部化的包走 Node 原生 ESM 导入）；本仓库已在 `vitest.config.ts` 里对这几个包配置 `server.deps.inline: ['@1inch/swap-vm-sdk', '@1inch/aqua-sdk', '@1inch/sdk-core', '@1inch/byte-utils']`，让 vite 内联处理其解析。新增测试文件无需再动。
   - → **生产运行建议用 `tsx src/main.ts` 之类的加载器，不要用 `node dist/main.js`**；如需纯 node 运行，后续任务需要引入 bundler（esbuild/rollup）或 patch 方案。
5. **Logger 的 bigint 坑**（项目级提醒）：`src/logger.ts` 用 `JSON.stringify(meta)`，`JSON.stringify` 遇到 bigint 会抛 `TypeError: Do not know how to serialize a BigInt`。**不要把含 bigint 的对象作为 meta 传给 Logger**，先 `toString()` 成字符串。
6. **事件字段全部非 indexed**：见 Q5，topic 只有一个（topic0），其余字段都在 data 里，`fromLog` 已封装。
7. **viem 兼容性**：`CallInfo.to/data` 是 `0x${string}`（`Hex`），可直接传给 viem 的 `sendTransaction`/`walletClient`，无需转换。
8. **报价方向**：SDK `Price.fromHuman` 的语义是「quote per 1 base」。本项目调用时 quoteToken=USDT、baseToken=1INCH，即 USDT per 1INCH = 项目价格口径 P（见 Q4.3）。

## 9. 本项目 `src/aqua-client.ts` 的落地决策汇总

| 决策点 | 结论 |
|---|---|
| 区间精度 | `instructions.concentrate.Price.fromHuman(String(p), {quoteToken: USDT, baseToken: 1INCH}).toSqrt()`，不手写 scale |
| 区间方向 | inch 侧 `[lower, upper]`、usdt 侧 `[lower, upper]` 直接由 `NewPosition` 提供（调用方按设计文档算好），封装层不做翻转 |
| 防御校验 | `sqrtPriceMin < sqrtPriceMax` 必须成立，否则 throw（防止未来 SDK/调用方错误） |
| strategyHash | `AquaProtocolContract.calculateStrategyHash(order.encode())`（= 链上 ship 返回值） |
| salt | 每次 `randomBytes(8)` → `withSalt(bigint)`，保证 hash 不重复（SDK 的 SaltArgs 仅接受 uint64） |
| ship 交易 | `AquaProtocolContract.buildShipTx(AQUA_CONTRACT_ADDRESSES[network], { app: router, strategy, amountsAndTokens: [{ token, amount }] })` |
| dock 交易 | `AquaProtocolContract.buildDockTx(registry, { app: router, strategyHash, tokens: [token] })` |
| 剩余余额 | viem `readContract` 调 `rawBalances(maker, router, strategyHash, token)`，取返回的 `balance`（uint248） |
| maker 地址 | 由 `cfg.privateKey` 经 viem `privateKeyToAccount` 推导；`buildShip` 的 `walletAddress` 参数直接进 Order.maker |
| tokenAddress 映射 | `side==='inch'` → `cfg.tokenInch`，否则 `cfg.tokenUsdt` |
| 链 | `cfg.chainId as NetworkEnum` 查两个地址表，查不到则 throw |
