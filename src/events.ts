import type { AquaClient } from './aqua-client.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Position } from './types.js';

/** 死行 tokensCount 标记：策略从未 ship（表内幽灵行） */
const TOKENS_NEVER_SHIPPED = 0;
/** 死行 tokensCount 标记：已 dock/不存在（合约 dock 后置 0xff） */
const TOKENS_DOCKED = 0xff;

/**
 * 链上对账：把每个仓位的剩余虚拟余额刷新到本地表。
 * - tokensCount ∈ {0, 0xff} → 死行：warn（注明 hash 与原因）后剔除。
 *   死行留在表内只会让熔断 dockAll 反复 revert（重启即死循环），必须自愈剔除。
 * - 读取抛错 → warn 后保留原值，下轮再试（静默旧值可能掩盖已排空仓位，必须留痕）。
 */
export async function refreshRemaining(
  aqua: AquaClient,
  positions: Position[],
  price: number,
  cfg: Config,
  logger: Logger,
): Promise<Position[]> {
  const decimals = (side: Position['side']) =>
    side === 'inch' ? cfg.tokenInchDecimals : cfg.tokenUsdtDecimals;

  const results = await Promise.all(
    positions.map(async (p): Promise<Position | null> => {
      try {
        const { remaining, tokensCount } = await aqua.getRemaining(p.strategyHash, p.tokenAddress);
        if (tokensCount === TOKENS_NEVER_SHIPPED || tokensCount === TOKENS_DOCKED) {
          const reason =
            tokensCount === TOKENS_DOCKED
              ? '链上已 dock（tokensCount=0xff）'
              : '从未 ship（tokensCount=0）';
          logger.warn(`对账剔除死行: hash=${p.strategyHash} 原因=${reason}`);
          return null;
        }
        const usd = Number(remaining) / 10 ** decimals(p.side) * (p.side === 'inch' ? price : 1);
        return { ...p, remainingUsd: usd };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        logger.warn(`仓位剩余余额读取失败（保留原值，下轮重试）: hash=${p.strategyHash} 原因=${reason}`);
        return p;
      }
    }),
  );
  return results.filter((r): r is Position => r !== null);
}
