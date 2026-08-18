import type { PublicClient, WalletClient } from 'viem';
import type { AquaClient } from './aqua-client.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { NewPosition, Position } from './types.js';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 链上执行层：把决策变成真实交易（ship/dock）。
 * 职责：广播、等回执、网络错误重试；不做任何策略判断。
 * 熔断全平（dockAll）也在这里：best-effort，单个失败不阻断。
 */
export class Executor {
  constructor(
    private aqua: AquaClient,
    private wallet: WalletClient,
    private publicClient: PublicClient,
    private logger: Logger,
    private cfg: Config,
  ) {}

  /** 广播并等待回执；网络类错误重试 MAX_RETRIES 次 */
  async withRetry<T>(fn: () => Promise<T>, op: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        this.logger.warn(`${op} 失败（第 ${attempt + 1}/${MAX_RETRIES + 1} 次）: ${String(e)}`);
        if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
      }
    }
    throw lastErr;
  }

  private async send(tx: { to: `0x${string}`; data: `0x${string}`; value: bigint }): Promise<`0x${string}`> {
    // viem 的 WalletClient 默认泛型下 account/chain 均可能未定义：account 由私钥构造必存在，
    // 用非空断言收窄（运行时 viem 会抛错兜底，由 withRetry 承接）；chain 传 undefined 与省略等价，
    // 运行时仍走 client.chain（viem 源码：chain = client.chain 兜底），不能传 null（那会真正丢弃 client.chain）
    const hash = await this.wallet.sendTransaction({
      account: this.wallet.account!,
      chain: undefined,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    // 回执 status 必须为 success：viem 的 waitForTransactionReceipt 对 revert 不抛错（仅超时/未找到/替换报错），
    // 不检查会把 revert 当成功——ship 会记下幻影仓位（资金锁定）、dock 会误删仓位
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`交易回执非成功（status=${receipt.status}）: ${hash}`);
    }
    return hash;
  }

  /** 开仓：构建 calldata → 广播 → 返回新仓位 strategyHash */
  async ship(pos: NewPosition): Promise<`0x${string}`> {
    const plan = await this.withRetry(
      () => this.aqua.buildShip(pos, this.wallet.account!.address),
      `构建 ship（${pos.side}）`,
    );
    await this.withRetry(() => this.send(plan.tx), `广播 ship（${pos.side}）`);
    this.logger.info(`ship 成功: ${pos.side} 区间 [${pos.lower.toFixed(6)}, ${pos.upper.toFixed(6)}] hash=${plan.strategyHash}`);
    return plan.strategyHash;
  }

  /** 平仓：构建 calldata → 广播 → 返回 txHash */
  async dock(strategyHash: `0x${string}`, tokenAddress: `0x${string}`): Promise<`0x${string}`> {
    const tx = await this.withRetry(
      () => this.aqua.buildDock(strategyHash, tokenAddress),
      `构建 dock（${strategyHash.slice(0, 12)}…）`,
    );
    const hash = await this.withRetry(() => this.send(tx), `广播 dock（${strategyHash.slice(0, 12)}…）`);
    this.logger.info(`dock 成功: ${strategyHash}`);
    return hash;
  }

  /**
   * 熔断全平：best-effort 逐个 dock，单个失败记录后继续；整体不抛错。
   * 返回成功 dock 的 strategyHash 数组：调用方据此把「确认已平」的行从表删除，
   * 失败行保留——删多了会失去对未平仓位的管理（真钱安全），删少了由对账死行自愈兜底。
   */
  async dockAll(positions: Position[]): Promise<string[]> {
    this.logger.warn(`熔断全平：共 ${positions.length} 个仓位`);
    const docked: string[] = [];
    for (const p of positions) {
      try {
        await this.dock(p.strategyHash, p.tokenAddress);
        docked.push(p.strategyHash);
      } catch (e) {
        this.logger.error(`dockAll 失败（继续下一个）: ${p.strategyHash} — ${String(e)}`);
      }
    }
    return docked;
  }
}
