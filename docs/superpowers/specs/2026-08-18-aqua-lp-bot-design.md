# aqua-lp-bot 设计规格（v1）

日期：2026-08-18
状态：已获用户确认（2026-08-18 对话）

## 1. 背景与目标

1inch 于 2026-07-28 启动「1inch Network Incentives」激励计划（约 2026-10-28 结束，写本文时余 72 天），奖励池 1000 万 1INCH + 50 万 USDC，按**仓位实际路由的成交量**（processed volume）在 Merkl 平台按 epoch 分配，而非按锁定资金。

用户目前**手动**在 1inch Aqua 上以 ~11,500U 本金对 1INCH/USDT 挂/平单边流动性仓位刷量。本项目的 v1 目标：

> 把用户的手动调仓动作自动化，释放人力。后期用户会基于本项目代码自行优化策略参数与逻辑。

**非目标（v1 不做）**：策略收益优化、多链、多交易对、事件驱动架构、Telegram 通知、服务器部署（用户在 Mac 本地直接运行）、参数自适应。

## 2. 核心策略规则（源自用户手动操作）

- 链：Ethereum 主网；交易对：1INCH/USDT
- 本金 ~11,500U，随成交在「满手 USDT」与「满手 1INCH」之间动态变化，Bot 按当前余额自动处理
- 价格锚点：1inch Spot Price API（与 Aqua 页面显示价格同源）

### 2.1 开仓规则

对每个方向（1INCH 侧 / USDT 侧）分别判断：

| 项目 | 规则 |
|---|---|
| 首仓触发 | 该侧资金 ≥ 6000U，且该方向仓位数 = 0 |
| 二仓触发 | 该方向仓位数 = 1，且距该方向最新仓位开仓 ≥ `POSITION_MIN_INTERVAL_S`（默认 240s，即 3–5 分钟），且价格沿成交方向偏离最新仓位区间 ≥ `PRICE_DRIFT_PCT`（默认 0.05%） |
| 仓位上限 | 单方向 ≤ 2 仓；每循环每方向最多开 1 仓 |
| 区间宽度 w | 按该侧资金定档：≥9000U → 0.06%（0.0006）；6000–9000U → 0.04%（0.0004） |
| 区间位置（重 1INCH） | 单边卖 1INCH：`[P, P × (1+w)]`（挂在当前价上方） |
| 区间位置（重 USDT） | 单边卖 USDT：`[P × (1−w), P]`（挂在当前价下方） |
| 资金（共享） | ship 仅链上记账、不动币；新仓位以该侧当前真实余额做虚拟分配，同一余额可同时支撑多仓（Aqua Shared Liquidity，成交时按真实余额原子结算封顶） |

其中：

- **侧资金** = 该侧钱包真实余额按 P 估值（不做「余额 − 已分配」扣除，因资金共享）
- **P** = 当前 1INCH 兑 USDT 价格（Spot Price API 两币 USD 价相除）
- **偏离定义**：卖侧仓位（重 1INCH 挂上方）为 P 高于区间上限的比例；买侧仓位（重 USDT 挂下方）为 P 低于区间下限的比例，即价格沿成交方向穿出区间 ≥ `PRICE_DRIFT_PCT`

### 2.2 平仓规则

| 规则 | 条件 | 动作 |
|---|---|---|
| 陈旧平仓 | 价格偏离某仓位区间超过 `STALE_DISTANCE_PCT`（默认 1%，即 P > 上限×1.01 或 P < 下限×0.99），且该方向仓位数量 ≥ 2 | dock 该方向**最旧**的仓位 |
| 空壳清理 | 仓位剩余虚拟余额为 0（已完全成交） | dock 清理，释放仓位槽 |

### 2.3 熔断规则

| 规则 | 条件 | 动作 |
|---|---|---|
| 循环熔断 | 连续失败 ≥ `MAX_CONSECUTIVE_FAILURES`（默认 3）次 | dock **全部**自己开过的仓位 → 停止 Bot 进程（exit 1） |
| 操作上限 | 单次循环链上操作数 ≥ `MAX_ACTIONS_PER_LOOP`（默认 4） | 剩余操作推迟到下一循环 |

失败定义：RPC 请求异常、交易上链失败（revert/超时）、状态对账不一致。

## 3. 架构

TypeScript + Node 20+，单进程定时轮询 keeper。依赖：`viem`（钱包/RPC）、`@1inch/aqua-sdk`（ship/dock calldata 构建、strategyHash、事件解码）、`@1inch/swap-vm-sdk`（策略程序编码）。与用户现有 spread-arb 的「定时任务循环」模式一致。

```
src/
├── main.ts        # 入口：装配模块、主循环、熔断停机、优雅退出（Ctrl+C）
├── config.ts      # 全部参数集中定义（含 .env 加载与默认值），中文注释
├── price/
│   ├── price-source.ts    # PriceSource 接口（getPrice(): Promise<number>，1INCH/USDT 价）
│   └── spot-price-api.ts  # 1inch Spot Price API 实现（默认）
├── inventory.ts   # 读钱包 1INCH/USDT 余额（ERC-20 balanceOf）+ 按 P 估值 + 侧可用资金计算
├── positions.ts   # 仓位状态表：本地记录（方向/区间/分配金额/开仓时间/strategyHash），白名单来源；持久化到 data/positions.json，重启不丢表
├── strategy.ts    # 决策纯函数：输入(价格, 两侧可用资金, 仓位表, 配置) → 输出(要 dock 的仓位列表, 要 ship 的新仓位列表)
├── executor.ts    # ship()/dock() 执行：nonce 管理、gas 估算、重试、失败计数、熔断与紧急全平
├── events.ts      # 链上事件解码（Shipped/Docked/Pushed/Pulled），仓位表对账
└── logger.ts      # 结构化日志：控制台 + logs/ 滚动文件（无 TG 通知）
tests/             # vitest 单测，重点是 strategy.ts 决策纯函数
```

### 数据流（单次循环）

```
取价(Spot Price API) → 读余额(RPC) → 估值与可用资金 → 决策(strategy 纯函数)
→ 执行(dock 旧仓 → ship 新仓，均只记账、gas 极低) → 事件对账(更新仓位表)
→ 熔断检查 → 等待 LOOP_INTERVAL_S（默认 60s）→ 下一循环
```

### 关键模块接口

- `strategy.ts` 为纯函数，不依赖 RPC/钱包，全部参数注入 → 可完整单测，后期用户改策略只改这里
- `price-source.ts` 为接口，未来可替换为 swapVm.quote 等其他实现
- `executor.ts` 只接受决策输出并执行，不包含策略判断

## 4. 配置参数（config.ts + .env）

| 参数 | 默认值 | 说明 |
|---|---|---|
| `PRIVATE_KEY` | 无（必填） | 做市钱包私钥，仅存 Mac 本地 .env，绝不进 git |
| `RPC_URL` | 无（必填） | Ethereum 主网 RPC |
| `API_KEY_1INCH` | 无（必填） | 1inch developer portal 的 Spot Price API key |
| `CHAIN_ID` | 1 | Ethereum 主网 |
| `TOKEN_INCH` | 0x111111111117dC0aa78b770fA6A738034120C302 | 1INCH 代币地址（实现时与 SDK 内置地址核对） |
| `TOKEN_USDT` | 0xdAC17F958D2ee523a2206206994597C13D831ec7 | USDT 地址（同上核对） |
| `MIN_SIDE_VALUE_USD` | 6000 | 开仓触发阈值（U） |
| `WIDTH_TIERS_USD` | {9000: 0.0006, 6000: 0.0004} | 区间宽度档位 |
| `MAX_POSITIONS_PER_SIDE` | 2 | 单方向仓位上限 |
| `STALE_DISTANCE_PCT` | 0.01 | 陈旧判定：价格离开区间的距离比例 |
| `LOOP_INTERVAL_S` | 60 | 循环间隔（用户手动时约 2-3 分钟看一次） |
| `POSITION_MIN_INTERVAL_S` | 240 | 同方向两仓最小开仓间隔（3–5 分钟取中） |
| `PRICE_DRIFT_PCT` | 0.0005 | 二仓触发：价格沿成交方向偏离最新仓位区间的比例 |
| `MAX_CONSECUTIVE_FAILURES` | 3 | 熔断阈值 |
| `MAX_ACTIONS_PER_LOOP` | 4 | 单循环操作上限 |
| `DRY_RUN` | false | 干跑：只计算决策并打日志，不广播交易 |

## 5. 安全设计

1. **私钥安全**：仅 `.env`（gitignore）；Public 仓库任何文件不得含私钥/密钥
2. **dock 白名单**：executor 只对本地仓位表内的 strategyHash 执行 dock；Bot 不认识的钱包内其他仓位（如用户在网页手动开的）一律不碰
3. **资金自托管**：Aqua 协议资金全程在钱包，ship/dock 只做链上记账；最坏情况是仓位挂着不成交，不存在被清算风险
4. **熔断即全平**：连续失败 → dock 全部自己的仓位 → 退出进程（用户可随时重启）
5. **干跑先行**：DRY_RUN=1 验证决策输出与真实手操一致后，再上真金
6. **操作幂等**：执行前校验仓位表与链上事件一致，避免重复 ship/dock

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| Spot Price API 超时/失败 | 重试 3 次后计一次循环失败；连续失败走熔断 |
| RPC 请求失败 | 同上 |
| 交易 revert（如余额不足） | 计失败，下一循环重新决策（余额已变） |
| 事件对账不一致 | 以链上为准重建仓位表，计一次失败 |
| 进程被 Ctrl+C | 优雅退出：完成当前循环后退出，**不**主动 dock（避免误关仓） |

## 7. 测试策略

- `strategy.ts` 决策纯函数：覆盖首仓/二仓触发（间隔+偏离条件）、档位宽度、方向区间、最旧先平、空壳清理、操作上限（核心）
- `inventory.ts` 可用资金计算：含「余额 − 已分配」边界
- executor/events 用 mock RPC 测（vitest + 注入式 provider）
- 上真钱前：DRY_RUN 模式人工比对 ≥1 天，确认与手操决策一致

## 8. 实施顺序

1. 脚手架（package.json/tsconfig/vitest/eslint）+ config + logger
2. price-source 接口 + spot-price-api 实现（mock 测试）
3. inventory + strategy 纯函数 + 单测（不依赖 API key）
4. executor：真实链上跑通一次 ship → 读事件 → dock 闭环（需 PRIVATE_KEY + RPC）
5. events 对账 + 仓位表持久化（JSON 文件，重启不丢表）
6. 主循环 + 熔断 + 优雅退出
7. DRY_RUN 验证 → 用户上真钱

## 9. 已知简化（用户后期可优化）

- 仓位「剩余虚拟余额」的读取方式（链上查询 vs 事件累计）实现时二选一，以能跑通为准
- 区间宽度档位为固定表；后期可改为连续函数
- `PRICE_DRIFT_PCT` 默认 0.05% 与 `POSITION_MIN_INTERVAL_S` 默认 240s 为初始取值，需在干跑阶段与你的手操节奏比对后调优
- 价格源单一（Spot Price API）；接口已预留替换位
