import 'dotenv/config';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createAquaClient } from './aqua-client.js';
import { loadConfig } from './config.js';
import { Executor } from './executor.js';
import { Logger } from './logger.js';
import { PositionsStore } from './positions.js';
import { SpotPriceApi } from './price/spot-price-api.js';
import { runLoop } from './loop.js';

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
