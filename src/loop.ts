import type { PublicClient } from 'viem';
import type { AquaClient } from './aqua-client.js';
import type { Config } from './config.js';
import type { Executor } from './executor.js';
import { refreshRemaining } from './events.js';
import { fetchBalances, toSideStates } from './inventory.js';
import type { Logger } from './logger.js';
import { PositionsStore } from './positions.js';
import type { PriceSource } from './price/price-source.js';
import { decide } from './strategy.js';
import type { NewPosition } from './types.js';

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
  // 价格必须是正有限数值：NaN/Infinity 会生成垃圾区间（NaN 比较恒 false），
  // 0/负价格会误平健康仓位或开出零宽区间——显式拒绝并计入循环失败，由熔断兜底（真钱安全）
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`价格源返回非有限或非正价格: ${price}`);
  }
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
      store.save(positions); // 每次表变更立即落盘（真钱安全，下同）
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
      store.save(positions);
    }
  } else {
    // 真实模式：先 dock 后 ship
    for (const p of decision.docks) {
      await executor.dock(p.strategyHash, p.tokenAddress);
      positions = positions.filter((x) => x.strategyHash !== p.strategyHash);
      store.save(positions);
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
      store.save(positions);
    }
  }

  // 对账：刷新各仓位剩余余额（只读链上调用，干跑同样执行）。
  // dry-* 占位行（DRY_RUN 假行）无链上真相：跳过对账（避免每轮 viem 报错噪声），
  // 但保留在表内（干跑模拟仓位上限/二仓间隔需要它们）；真实行照常对账。
  const dryRows = positions.filter((p) => p.strategyHash.startsWith('dry-'));
  const realRows = positions.filter((p) => !p.strategyHash.startsWith('dry-'));
  positions = [...dryRows, ...(await refreshRemaining(aqua, realRows, price, cfg, logger))];
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
          const docked = await executor.dockAll(store.load());
          // 只删除确认 dock 成功的行；失败行保留在表（重启后继续处理/由对账死行自愈剔除）。
          // 若不清表，熔断成功的行会残留成死行——重启后每次熔断都反复 dock 它们（死循环）。
          store.save(store.load().filter((p) => !docked.includes(p.strategyHash)));
        }
        process.exit(1);
      }
    }
    await sleep(cfg.loopIntervalS * 1000);
  }
}
