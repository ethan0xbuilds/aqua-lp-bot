import type { Config } from './config.js';
import type { Decision, NewPosition, Position, Side, SideState } from './types.js';

/**
 * 核心决策纯函数：输入当前状态 → 输出要 dock/要 ship 的仓位。
 * 不依赖 RPC、钱包、SDK，全部参数注入，可完整单测。
 * 用户后期优化策略只改本文件。
 */

/** 按侧资金取区间宽度档位（widthTiersUsd 降序） */
function widthFor(cfg: Config, balanceUsd: number): number {
  for (const tier of cfg.widthTiersUsd) {
    if (balanceUsd >= tier.threshold) return tier.width;
  }
  return cfg.widthTiersUsd[cfg.widthTiersUsd.length - 1].width;
}

/** 价格沿成交方向穿出区间超过 driftPct（卖侧看上限，买侧看下限） */
function priceDriftedBeyond(price: number, p: Position, driftPct: number): boolean {
  if (p.side === 'inch') return price > p.upper * (1 + driftPct);
  return price < p.lower * (1 - driftPct);
}

/** 陈旧判定：价格离开区间超过 stalePct（上超上限或下破下限） */
function priceStaleBeyond(price: number, p: Position, stalePct: number): boolean {
  return price > p.upper * (1 + stalePct) || price < p.lower * (1 - stalePct);
}

/** 计算新仓位区间与资金（共享：全额虚拟分配） */
function buildNewPosition(cfg: Config, price: number, side: Side, tokenBalance: bigint, balanceUsd: number): NewPosition {
  const w = widthFor(cfg, balanceUsd);
  if (side === 'inch') {
    return { side, lower: price, upper: price * (1 + w), tokenAmount: tokenBalance };
  }
  return { side, lower: price * (1 - w), upper: price, tokenAmount: tokenBalance };
}

/** 对单个方向做决策 */
function planSide(
  cfg: Config,
  price: number,
  side: Side,
  state: SideState,
  nowMs: number,
): { docks: Position[]; ships: NewPosition[]; reasons: string[] } {
  const docks: Position[] = [];
  const ships: NewPosition[] = [];
  const reasons: string[] = [];
  const positions = state.positions; // 已按 openedAtMs 升序

  // 1) 空壳清理：剩余 < 阈值（任何数量）
  for (const p of positions) {
    if (p.remainingUsd < cfg.emptyPositionThresholdUsd) {
      docks.push(p);
      reasons.push(`${side} 侧仓位 ${p.strategyHash.slice(0, 12)}… 剩余 ${p.remainingUsd.toFixed(1)}U < ${cfg.emptyPositionThresholdUsd}U，dock 清理空壳`);
    }
  }
  const survivors = positions.filter((p) => !docks.includes(p));

  // 2) 陈旧平仓：≥2 仓且最旧仓价格离开区间 > staleDistancePct → dock 最旧
  if (survivors.length >= 2 && priceStaleBeyond(price, survivors[0], cfg.staleDistancePct)) {
    docks.push(survivors[0]);
    reasons.push(`${side} 侧 2 仓且最旧仓区间已偏离价格 ${(cfg.staleDistancePct * 100).toFixed(0)}% 以上，dock 最旧 ${survivors[0].strategyHash.slice(0, 12)}…`);
  }
  const afterDocks = positions.filter((p) => !docks.includes(p));

  // 3) 开仓：首仓 / 二仓滚动
  if (state.balanceUsd >= cfg.minSideValueUsd && afterDocks.length < cfg.maxPositionsPerSide) {
    let canOpen = false;
    let skipReason = '';
    if (afterDocks.length === 0) {
      canOpen = true; // 首仓：只要资金够
    } else {
      const latest = afterDocks[afterDocks.length - 1];
      const elapsedS = (nowMs - latest.openedAtMs) / 1000;
      if (elapsedS < cfg.positionMinIntervalS) {
        skipReason = `距最新仓开仓仅 ${elapsedS.toFixed(0)}s（< ${cfg.positionMinIntervalS}s）`;
      } else if (!priceDriftedBeyond(price, latest, cfg.priceDriftPct)) {
        skipReason = `价格未沿成交方向偏离最新仓区间 ${(cfg.priceDriftPct * 100).toFixed(3)}%`;
      } else {
        canOpen = true; // 二仓滚动
      }
    }
    if (canOpen) {
      const np = buildNewPosition(cfg, price, side, state.tokenBalance, state.balanceUsd);
      ships.push(np);
      const w = np.side === 'inch' ? np.upper / price - 1 : 1 - np.lower / price;
      reasons.push(
        `${side} 侧资金 ${state.balanceUsd.toFixed(0)}U ≥ ${cfg.minSideValueUsd}U（${afterDocks.length} 仓），开${afterDocks.length === 0 ? '首' : '二'}仓：区间 [${np.lower.toFixed(6)}, ${np.upper.toFixed(6)}]，宽度 ${(w * 100).toFixed(3)}%`,
      );
    } else if (state.balanceUsd >= cfg.minSideValueUsd) {
      reasons.push(`${side} 侧资金达标但暂不开仓：${skipReason}`);
    }
  }

  return { docks, ships, reasons };
}

/**
 * 一次循环的完整决策。
 * 操作上限：dock 优先（先到先得），总数截断到 maxActionsPerLoop，剩余推迟下一循环。
 */
export function decide(
  cfg: Config,
  price: number,
  inch: SideState,
  usdt: SideState,
  nowMs: number,
): Decision {
  const a = planSide(cfg, price, 'inch', inch, nowMs);
  const b = planSide(cfg, price, 'usdt', usdt, nowMs);

  let docks = [...a.docks, ...b.docks];
  let ships = [...a.ships, ...b.ships];
  const reasons = [...a.reasons, ...b.reasons];

  if (docks.length + ships.length > cfg.maxActionsPerLoop) {
    docks = docks.slice(0, cfg.maxActionsPerLoop);
    const slots = cfg.maxActionsPerLoop - docks.length;
    ships = ships.slice(0, slots);
    reasons.push(`本循环操作数超过上限 ${cfg.maxActionsPerLoop}，截断（dock 优先，剩余推迟下一循环）`);
  }

  return { docks, ships, reasons };
}
