import type { PublicClient } from 'viem';
import type { Config } from './config.js';
import { bySide } from './positions.js';
import type { Position, SideState } from './types.js';

/** 钱包两侧代币余额（原生单位） */
export interface Balances {
  inch: bigint;
  usdt: bigint;
}

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** 读取钱包 1INCH / USDT 余额（Aqua 资金自托管：余额即全部可用资金） */
export async function fetchBalances(
  publicClient: PublicClient,
  walletAddress: `0x${string}`,
  cfg: Config,
): Promise<Balances> {
  const [inch, usdt] = await Promise.all([
    publicClient.readContract({
      address: cfg.tokenInch,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [walletAddress],
    }),
    publicClient.readContract({
      address: cfg.tokenUsdt,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [walletAddress],
    }),
  ]);
  return { inch, usdt };
}

function toUsd(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

/**
 * 把余额 + 仓位表组装成两侧决策输入。
 * 估值用当前价格 P；仓位按方向归位（已升序）。
 * 注意：Aqua 共享资金，侧资金 = 钱包全额估值，不扣除已分配。
 */
export function toSideStates(
  balances: Balances,
  price: number,
  positions: Position[],
  cfg: Config,
): { inch: SideState; usdt: SideState } {
  const inchUsd = toUsd(balances.inch, cfg.tokenInchDecimals) * price;
  const usdtUsd = toUsd(balances.usdt, cfg.tokenUsdtDecimals);
  return {
    inch: { tokenBalance: balances.inch, balanceUsd: inchUsd, positions: bySide(positions, 'inch') },
    usdt: { tokenBalance: balances.usdt, balanceUsd: usdtUsd, positions: bySide(positions, 'usdt') },
  };
}
