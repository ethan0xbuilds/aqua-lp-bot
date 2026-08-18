/**
 * 全局共享类型定义。
 * 价格一律为「1 枚 1INCH 兑多少 USDT」的浮点数；金额一律为 U（美元估值）。
 */

/** 仓位方向：inch=重 1INCH（卖 1INCH，区间挂上方）；usdt=重 USDT（卖 USDT，区间挂下方） */
export type Side = 'inch' | 'usdt';

/** 一个已开（或假设已开，干跑模式）的 Aqua 仓位 */
export interface Position {
  strategyHash: `0x${string}`;
  side: Side;
  /** 该仓位对应的代币地址（dock 时需要） */
  tokenAddress: `0x${string}`;
  /** 价格区间（USDT/1INCH）：卖 1INCH 挂在当前价上方，卖 USDT 挂在下方 */
  lower: number;
  upper: number;
  /** 开仓时分配的估值（U） */
  allocatedUsd: number;
  /** 剩余虚拟余额估值（U），随成交递减；低于 emptyPositionThresholdUsd 视为空壳 */
  remainingUsd: number;
  /** 开仓时间（epoch ms），用于「最旧先平」与二仓间隔判断 */
  openedAtMs: number;
}

/** 待开新仓（决策产物） */
export interface NewPosition {
  side: Side;
  lower: number;
  upper: number;
  /** 该侧代币数量（原生单位）。Aqua 共享资金：用该侧钱包全额做虚拟分配 */
  tokenAmount: bigint;
}

/** 某一侧（1INCH 侧或 USDT 侧）的决策输入状态 */
export interface SideState {
  /** 该侧钱包代币余额（原生单位） */
  tokenBalance: bigint;
  /** 该侧估值（U） */
  balanceUsd: number;
  /** 该方向现存仓位，按 openedAtMs 升序 */
  positions: Position[];
}

/** 一次循环的决策产物 */
export interface Decision {
  /** 要 dock 的仓位（先于 ships 执行） */
  docks: Position[];
  /** 要 ship 的新仓位 */
  ships: NewPosition[];
  /** 人类可读的决策理由（写日志用） */
  reasons: string[];
}
