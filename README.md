# aqua-lp-bot

1inch Aqua 单边流动性自动做市 bot：Ethereum 主网 1INCH/USDT 交易对，定时轮询「取价 → 读余额 → 决策 → ship/dock → 链上对账」闭环，把手动挂/平单边仓位的操作自动化。Mac 本地运行，真钱系统，无 Telegram 通知。

- 技术栈：TypeScript（strict）+ Node ≥ 20 + ESM（NodeNext）+ viem + `@1inch/aqua-sdk` + `@1inch/swap-vm-sdk`；测试用 vitest，运行用 tsx
- 取价：1inch Spot Price API（与 Aqua 页面显示价格同源）
- 激励：1inch Network Incentives 计划按仓位**实际路由的成交量**（processed volume）分配奖励，而非锁定资金——所以策略目标是让仓位随价格滚动、持续挂单成交

## 原理（策略规则）

价格口径：`P` = 1 枚 1INCH 兑多少 USDT（Spot Price API 两币 USD 价相除）。每个方向独立决策，一次循环先 dock 后 ship。

### 开仓规则

| 项目 | 规则 |
|---|---|
| 首仓触发 | 该侧资金 ≥ `MIN_SIDE_VALUE_USD`（默认 6000U），且该方向仓位数 = 0 |
| 二仓触发 | 该方向仓位数 = 1，且距最新仓开仓 ≥ `POSITION_MIN_INTERVAL_S`（默认 240s），且价格沿成交方向偏离最新仓区间 ≥ `PRICE_DRIFT_PCT`（默认 0.05%） |
| 仓位上限 | 单方向 ≤ `MAX_POSITIONS_PER_SIDE`（默认 2 仓） |
| 区间宽度 w | 按该侧资金定档：≥9000U → 0.06%；≥6000U → 0.04%（代码常量 `widthTiersUsd`） |
| 重 1INCH（inch 侧） | 单边卖 1INCH：区间 `[P, P × (1+w)]`，挂在当前价上方，价格上涨才卖出 |
| 重 USDT（usdt 侧） | 单边卖 USDT：区间 `[P × (1−w), P]`，挂在当前价下方，价格下跌才买入 1INCH |
| 资金（共享） | ship 只做链上记账、**不动币**；新仓以该侧钱包当前全额余额做虚拟分配，同一余额可同时支撑多仓（Aqua Shared Liquidity，成交时按真实余额原子结算封顶） |

侧资金 = 该侧钱包真实余额按 P 估值（不扣除已分配，因资金共享）。

### 平仓规则

| 规则 | 条件 | 动作 |
|---|---|---|
| 陈旧平仓 | 该方向仓位 ≥ 2，且价格离开**最旧仓**区间超过 `STALE_DISTANCE_PCT`（默认 1%，P > 上限×1.01 或 P < 下限×0.99） | dock 该方向**最旧**的仓位 |
| 空壳清理 | 仓位剩余虚拟余额 < `EMPTY_POSITION_THRESHOLD_USD`（默认 100U，基本成交完） | dock 清理，释放仓位槽 |

### 熔断与操作上限

| 规则 | 条件 | 动作 |
|---|---|---|
| 循环熔断 | 连续失败 ≥ `MAX_CONSECUTIVE_FAILURES`（默认 3）次 | dock **全部**自己开过的仓位 → 进程退出（exit 1） |
| 操作上限 | 单次循环链上操作 > `MAX_ACTIONS_PER_LOOP`（默认 4） | 截断（dock 优先），剩余推迟到下一循环 |

## 快速开始

```bash
# 1. 要求 Node ≥ 20
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入三个必填项：
#   PRIVATE_KEY=做市钱包私钥（仅存本地，绝不提交）
#   RPC_URL=Ethereum 主网 RPC URL
#   API_KEY_1INCH=1inch developer portal 申请：https://portal.1inch.dev
#     （Spot Price API 文档：https://business.1inch.com/portal/documentation/overview/products）

# 3. 干跑验证（只决策打日志，不广播任何交易）
DRY_RUN=true npm start

# 4. 确认决策与手动操作一致后，正式运行
npm start
```

## 运行方式

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发模式（tsx watch，改文件自动重启） |
| `npm start` | 正式运行（tsx 直接跑 src/main.ts） |
| `DRY_RUN=true npm start` | 干跑：只计算决策并打日志，不广播；本地仓位表按「假设执行成功」推进（占位 hash `dry-*`） |

- 循环间隔默认 60s；Ctrl+C 优雅退出（**不**主动 dock，避免误关仓）
- 日志：控制台 + `logs/app-YYYY-MM-DD.log` 滚动文件
- **切换实盘前**：干跑会在 `data/positions.json` 留下 `dry-*` 占位行，请先清空或备份该文件（程序会拒绝带 `dry-*` 行的表启动实盘）
- 注意：`npm run build` 只用于生成 dist 产物验证；`@1inch/swap-vm-sdk` 打包产物存在无扩展名 import，直接 `node dist/main.js` 必崩，运行请一律用 `npm start`（tsx）

## 冒烟测试（小仓位真钱闭环）

用显式参数在小资金测试钱包上验证 ship → dock 真实上链闭环，与策略阈值无关。

准备：测试钱包约 100U（1INCH/USDT 各半），`.env` 指向该钱包：

```bash
npm run smoke -- ship --side inch --amount 50      # 挂 50U 卖 1INCH 仓位
npm run smoke -- ship --side usdt --amount 50      # 挂 50U 卖 USDT 仓位
npm run smoke -- dock --strategy-hash 0x...        # 平掉指定仓位
npm run smoke -- dock-all                          # 平掉本地表全部仓位
```

- `--amount` 为美元估值（U），脚本强制 `0 < amount ≤ 100`（与「约 100U 测试钱包」一致）：inch 侧按当前价格换算成 1INCH 数量，usdt 侧 1:1 换算成 USDT 数量（内部使用原生单位：1INCH 1e18 / USDT 1e6）
- 区间宽度档位与主策略一致：≥9000U → 0.06%，否则 0.04%
- `dock` / `dock-all` 不拉取价格源（应急平仓路径，1inch API 宕机时仍可用）；`dock-all` 广播前会询问「确认平掉本地表全部 N 个仓位？(y/N)」，输入 y 才广播，其他输入直接取消
- **ship 只广播交易、返回 strategyHash，不写入本地仓位表**；dock 从 `data/positions.json` 反查仓位对应的代币，表外 hash 一律拒绝（白名单安全）
- **表清理**：`dock` 成功后自动从表删除该行；`dock-all` 只删除确认 dock 成功的行（失败行保留在表，下次继续处理）。熔断全平同理——表只保留未平/未确认的仓位；已被链上 dock 或从未 ship 的死行由主循环对账自动剔除（自愈），无需手工清理
- 因此平掉冒烟仓位前，需手动在 `data/positions.json` 登记该仓位（字段见 `src/types.ts` 的 `Position`）：

```json
[
  {
    "strategyHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "side": "inch",
    "tokenAddress": "0x111111111117dC0aa78b770fA6A738034120C302",
    "lower": 0.1,
    "upper": 0.10004,
    "allocatedUsd": 50,
    "remainingUsd": 50,
    "openedAtMs": 1755555555555
  }
]
```

（替换说明：`strategyHash` 填 ship 命令打印的真实 hash；`lower`/`upper` 填 ship 命令打印的区间；`openedAtMs` 填开仓时间 epoch 毫秒；`side` 为 `inch` 时 `tokenAddress` 填 1INCH 地址，`usdt` 时填 `0xdAC17F958D2ee523a2206206994597C13D831ec7`。示例可直接粘贴，再替换上述占位值。）

## 参数表（全部 env 键与默认值）

必填：

| 键 | 默认值 | 说明 |
|---|---|---|
| `PRIVATE_KEY` | 无 | 做市钱包私钥，仅存 Mac 本地 `.env`，绝不进 git |
| `RPC_URL` | 无 | Ethereum 主网 RPC URL |
| `API_KEY_1INCH` | 无 | 1inch Spot Price API key（https://portal.1inch.dev 申请） |

可选（覆盖默认值）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `CHAIN_ID` | `1` | 链 ID（SDK 地址表仅覆盖 NetworkEnum 覆盖的链，其他值启动即拒绝） |
| `MIN_SIDE_VALUE_USD` | `6000` | 开仓触发阈值（U）：该侧资金 ≥ 此值才开仓 |
| `MAX_POSITIONS_PER_SIDE` | `2` | 单方向仓位上限 |
| `STALE_DISTANCE_PCT` | `0.01` | 陈旧判定：价格离开仓位的区间比例（1%） |
| `EMPTY_POSITION_THRESHOLD_USD` | `100` | 空壳判定：仓位剩余虚拟余额低于该值（U）则 dock |
| `PRICE_DRIFT_PCT` | `0.0005` | 二仓触发：价格沿成交方向偏离最新仓区间的比例（0.05%） |
| `POSITION_MIN_INTERVAL_S` | `240` | 同方向两仓最小开仓间隔（秒） |
| `LOOP_INTERVAL_S` | `60` | 主循环间隔（秒） |
| `MAX_CONSECUTIVE_FAILURES` | `3` | 熔断阈值：连续失败次数达到即全平退出 |
| `MAX_ACTIONS_PER_LOOP` | `4` | 单循环链上操作上限 |
| `DRY_RUN` | `false` | 干跑开关；严格校验，只接受 `true/false` 或 `1/0`，拼写错误一律拒绝启动（避免「想干跑却实盘」） |

代码常量（`src/config.ts` 的 `DEFAULTS`，暂不支持 env 覆盖，改调参请直接改该文件）：

| 常量 | 值 | 说明 |
|---|---|---|
| `tokenInch` / `tokenInchDecimals` | `0x111111111117dC0aa78b770fA6A738034120C302` / `18` | 1INCH 代币 |
| `tokenUsdt` / `tokenUsdtDecimals` | `0xdAC17F958D2ee523a2206206994597C13D831ec7` / `6` | USDT 代币 |
| `widthTiersUsd` | `[{9000, 0.0006}, {6000, 0.0004}]` | 区间宽度档位（按侧资金降序匹配） |

## 安全须知

1. **私钥**：仅存本地 `.env`（gitignored），Public 仓库任何文件不得含私钥/API key
2. **dock 白名单**：executor 只对本地仓位表（`data/positions.json`）内的 strategyHash 执行 dock；钱包里其他仓位（如网页手动开的）一律不碰
3. **资金自托管**：Aqua 协议资金全程留在自己钱包，ship/dock 只做链上记账、不转账；最坏情况是仓位挂着不成交，不存在被清算风险
4. **熔断即全平**：连续失败 → dock 全部自己仓位 → 退出进程（可随时重启恢复）。熔断只从表删除**确认 dock 成功**的行——未平/未确认的仓位行保留在表，重启后继续处理；已被链上 dock（tokensCount=0xff）或从未 ship（tokensCount=0）的死行由每轮对账自动剔除（自愈），无需手工清理
5. **干跑先行**：`DRY_RUN=true` 验证决策输出与真实手操一致后，再上真金
6. **一次一 hash**：Aqua 协议要求同一 strategyHash 只能 ship 一次（dock 后同样永久占用），bot 每次 ship 用随机 salt 保证唯一
7. **链 ID 校验**：启动时显式校验 RPC 实际链 ID 与 `CHAIN_ID` 一致（Aqua 注册表地址 12 条链完全相同，连错链交易照发不误，必须拦住）
8. **孤儿仓（已知限制）**：ship 广播成功但回执超时，可能产生「链上有仓、表内无行」的孤儿仓——bot 无法管理它（dock 白名单查不到），属已知限制；v0.2 以链上 Shipped/Docked 事件扫描重建仓位表解决
9. **Ctrl+C 立即退出（已知限制）**：SIGINT 立即退出进程，不等待当前循环收尾；因每次仓位表变更立即落盘，中途截断的风险窗口为毫秒级

## 目录结构

```
src/
├── main.ts        # 入口：装配模块、主循环、SIGINT 优雅退出
├── config.ts      # 全部参数集中定义（默认值 + .env 覆盖），中文注释
├── types.ts       # 全局共享类型（Side / Position / NewPosition / SideState / Decision）
├── price/
│   ├── price-source.ts    # PriceSource 接口（未来可换其他价格源实现）
│   └── spot-price-api.ts  # 1inch Spot Price API 实现（默认）
├── inventory.ts   # 读钱包 1INCH/USDT 余额 + 按 P 估值 + 组装决策输入
├── positions.ts   # 仓位表：本地白名单持久化（data/positions.json，重启不丢表）
├── strategy.ts    # 决策纯函数：输入(价格, 两侧状态, 仓位表, 配置) → 输出(docks, ships)；调策略只改这里
├── executor.ts    # ship/dock 执行：广播、等回执（revert 视为失败）、重试、熔断全平
├── events.ts      # 链上对账：刷新每个仓位的剩余虚拟余额
├── aqua-client.ts # Aqua SDK 薄封装（全项目唯一 import @1inch/* 的地方）
├── loop.ts        # 主循环：单次迭代编排 + 失败计数熔断
└── logger.ts      # 结构化日志：控制台 + logs/ 滚动文件（无 TG 通知）
scripts/
└── smoke-test.ts  # 冒烟测试：小仓位显式参数验证 ship/dock 真实上链闭环
tests/             # vitest 单测（决策纯函数为核心）
docs/
├── SDK_NOTES.md   # Aqua SDK 探索笔记（真实签名、精度格式、踩坑记录）
└── superpowers/   # 设计规格与实施计划
data/positions.json # 仓位表（运行时生成，gitignored）
logs/              # 运行日志（gitignored）
```

## 测试与检查

```bash
npm test            # vitest 全量单测（tests/）
npm run typecheck   # tsc --noEmit 严格类型检查
npm run build       # tsc 产物生成（dist/，仅验证用；运行请用 npm start）
```
