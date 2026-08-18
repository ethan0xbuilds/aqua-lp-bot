/**
 * 冒烟测试：小仓位验证真实上链闭环。
 *
 * 用法（先准备测试钱包：约 100U，1INCH/USDT 各半，.env 指向该钱包）：
 *   npm run smoke -- ship --side inch --amount 50      # 挂 50U 卖 1INCH 仓位（强制 0 < amount ≤ 100）
 *   npm run smoke -- ship --side usdt --amount 50      # 挂 50U 卖 USDT 仓位
 *   npm run smoke -- dock --strategy-hash 0x...        # 平掉指定仓位（不依赖价格源）
 *   npm run smoke -- dock-all                          # 平掉本地表全部仓位（广播前人工确认，不依赖价格源）
 *
 * 注意：ship 只广播交易并返回 strategyHash，不写入本地仓位表；dock 从
 * data/positions.json 反查仓位对应的代币（表外 hash 一律拒绝），dock
 * 成功后自动把该行从表删除（防死行残留）。因此平掉冒烟仓位前需先在
 * data/positions.json 手动登记该仓位（字段见 src/types.ts 的 Position），
 * 详见 README「冒烟测试」。
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createAquaClient } from '../src/aqua-client.js';
import { assertChainId } from '../src/chain-check.js';
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
  // chain: undefined 与 src/main.ts 一致（运行时 viem 走 client.chain 兜底，见 executor.ts send() 注释）
  const publicClient = createPublicClient({ chain: undefined, transport: http(cfg.rpcUrl) });
  // 启动守卫：RPC 实际链 ID 必须与配置一致（Aqua 注册表地址 12 链通用，连错链不易察觉）
  await assertChainId(publicClient, cfg.chainId);
  const wallet = createWalletClient({ account, chain: undefined, transport: http(cfg.rpcUrl) });
  const aqua = await createAquaClient(cfg);
  const executor = new Executor(aqua, wallet, publicClient, logger, cfg);
  logger.info(`钱包: ${account.address}`);

  if (cmd === 'ship') {
    // 价格只 ship 需要：dock/dock-all 是应急平仓路径，不能被价格源故障阻塞
    //（主循环熔断全平同样不依赖价格，见 src/loop.ts）
    const price = await new SpotPriceApi({
      apiKey: cfg.apiKey1inch,
      tokenInch: cfg.tokenInch,
      tokenUsdt: cfg.tokenUsdt,
      chainId: cfg.chainId,
    }).getPrice();
    logger.info(`当前价格: ${price.toFixed(6)} USDT/1INCH`);
    const side = rest[rest.indexOf('--side') + 1];
    const amountUsd = Number(rest[rest.indexOf('--amount') + 1]);
    // 金额守卫（真钱安全）：0 < amount ≤ 100U。0/负数会让下游 BigInt 转换报错令人困惑；
    // 无上界则 50 误输成 50000 会真实挂大仓位——上限与 README「约 100U 测试钱包」一致
    const amountOk = Number.isFinite(amountUsd) && amountUsd > 0 && amountUsd <= 100;
    if ((side !== 'inch' && side !== 'usdt') || !amountOk) {
      if (!amountOk) {
        console.error(`--amount 必须是 0 < amount ≤ 100 的美元估值（收到: ${amountUsd}），约 100U 测试钱包`);
      }
      usage();
    }

    // amountUsd 为美元估值：inch 侧除以价格、usdt 侧 1:1，换算成代币原生单位（1INCH 1e18 / USDT 1e6）
    const decimals = side === 'inch' ? cfg.tokenInchDecimals : cfg.tokenUsdtDecimals;
    const tokenAmount = BigInt(Math.round(amountUsd / (side === 'inch' ? price : 1) * 10 ** decimals));
    const w = amountUsd >= 9000 ? 0.0006 : 0.0004; // 与 strategy 同档位规则
    const lower = side === 'inch' ? price : price * (1 - w);
    const upper = side === 'inch' ? price * (1 + w) : price;
    logger.info(`准备 ship：${side} 侧 ${amountUsd}U，区间 [${lower.toFixed(6)}, ${upper.toFixed(6)}]`);
    const hash = await executor.ship({ side, lower, upper, tokenAmount });
    logger.info(`✅ ship 完成，strategyHash=${hash}`);
    logger.info('提示：ship 不写仓位表；如需 dock 该仓位，请先在 data/positions.json 登记（见 README「冒烟测试」）');
  } else if (cmd === 'dock') {
    // dock 需要知道仓位对应的代币：从本地仓位表反查，表外 hash 一律拒绝（白名单安全）
    if (rest.indexOf('--strategy-hash') === -1) usage();
    const hash = rest[rest.indexOf('--strategy-hash') + 1] as `0x${string}`;
    if (!hash) usage();
    const store = new PositionsStore('data/positions.json');
    const found = store.load().find((p) => p.strategyHash === hash);
    if (!found) {
      logger.error(`本地仓位表找不到 ${hash}，拒绝 dock`);
      process.exit(1);
    }
    const tx = await executor.dock(found.strategyHash, found.tokenAddress);
    logger.info(`✅ dock 完成，tx=${tx}`);
    // dock 成功后从本地表清除该行：残留死行会让主循环熔断时反复 dock 它（重启即死循环）
    store.save(store.load().filter((p) => p.strategyHash !== found.strategyHash));
    logger.info('已从本地仓位表删除该行');
  } else if (cmd === 'dock-all') {
    const store = new PositionsStore('data/positions.json');
    const positions = store.load();
    // 真钱安全：一条命令平掉表内全部仓位，.env 若误指实盘钱包即全平实盘——
    // 广播前必须人工确认；非 y 输入直接取消（不广播、不改表）
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`确认平掉本地表全部 ${positions.length} 个仓位？(y/N) `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      logger.info('已取消 dock-all（未广播任何交易）');
      process.exit(0);
    }
    const docked = await executor.dockAll(positions);
    logger.info(`✅ dock-all 完成（成功 ${docked.length}/${positions.length}）`);
    // 只删确认 dock 成功的行：失败行保留在表，便于下次继续处理（不误删未平仓位）
    store.save(store.load().filter((p) => !docked.includes(p.strategyHash)));
  } else {
    usage();
  }
}

main().catch((e) => {
  console.error('冒烟失败:', e);
  process.exit(1);
});
