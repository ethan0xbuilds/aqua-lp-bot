import type { AquaClient } from './aqua-client.js';
import type { Config } from './config.js';
import type { Position } from './types.js';

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
        return p; // 读失败：保留原值
      }
    }),
  );
  return results;
}
