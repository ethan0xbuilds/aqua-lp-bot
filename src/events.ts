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
