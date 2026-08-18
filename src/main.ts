import 'dotenv/config';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createAquaClient } from './aqua-client.js';
import { assertChainId } from './chain-check.js';
import { loadConfig } from './config.js';
import { Executor } from './executor.js';
import { Logger } from './logger.js';
import { PositionsStore } from './positions.js';
import { SpotPriceApi } from './price/spot-price-api.js';
import { runLoop } from './loop.js';

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const logger = new Logger('info');
  const store = new PositionsStore('data/positions.json');

  // 启动守卫（真钱安全）：DRY_RUN 会在表中留下 dry-* 占位行（无链上真相）。
  // 带它们启动实盘，决策会把假行当真实仓位处理（空壳 dock 等）——绝不启动，
  // 明确指引用户先清空/备份表
  if (!cfg.dryRun) {
    const dryRows = store.load().filter((p) => p.strategyHash.startsWith('dry-'));
    if (dryRows.length > 0) {
      console.error(
        `检测到 ${dryRows.length} 行 DRY_RUN 残留（strategyHash 以 dry- 开头），拒绝启动实盘。` +
          `请先清空或备份 data/positions.json（如：mv data/positions.json data/positions.dry-run-backup.json），` +
          `确认无误后重新启动。`,
      );
      process.exit(1);
    }
  }

  const account = privateKeyToAccount(cfg.privateKey);
  const publicClient = createPublicClient({ chain: undefined, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, chain: undefined, transport: http(cfg.rpcUrl) });
  // 启动守卫：RPC 实际链 ID 必须与配置一致（Aqua 注册表地址 12 链通用，连错链不易察觉）
  await assertChainId(publicClient, cfg.chainId);
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
    store,
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
