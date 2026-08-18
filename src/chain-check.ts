import type { PublicClient } from 'viem';

/**
 * 启动守卫：显式校验 RPC 实际链 ID 与配置一致。
 * Aqua 注册表/路由器地址 12 条链完全相同（SDK_NOTES Q7），连错链交易照发不误——
 * 只有 chainId 校验能拦住「配置写主网、RPC 实际是其他链」的静默错链操作（真钱安全）。
 */
export async function assertChainId(publicClient: PublicClient, expected: number): Promise<void> {
  const actual = await publicClient.getChainId();
  if (actual !== expected) {
    throw new Error(
      `RPC 实际链 ID（${actual}）与配置 chainId（${expected}）不一致，拒绝启动` +
        `（Aqua 注册表地址 12 链通用，连错链不易察觉，必须显式校验）`,
    );
  }
}
