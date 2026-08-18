import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { assertChainId } from '../src/chain-check.js';

function clientWith(chainId: number): PublicClient {
  return { getChainId: async () => chainId } as unknown as PublicClient;
}

describe('assertChainId', () => {
  it('RPC 链 ID 与配置一致 → 通过', async () => {
    await expect(assertChainId(clientWith(1), 1)).resolves.toBeUndefined();
  });

  it('RPC 链 ID 与配置不一致 → 抛错拒绝启动', async () => {
    await expect(assertChainId(clientWith(137), 1)).rejects.toThrow(/137/);
    await expect(assertChainId(clientWith(1), 1)).resolves.toBeUndefined();
    // 错误信息必须同时包含实际链 ID 与配置值（排查依据）
    await expect(assertChainId(clientWith(8453), 1)).rejects.toThrow(/8453/);
    await expect(assertChainId(clientWith(8453), 1)).rejects.toThrow(/1/);
  });

  it('getChainId 抛错 → 原样向上抛（启动失败，绝不带病启动）', async () => {
    const broken = { getChainId: async () => Promise.reject(new Error('rpc down')) } as unknown as PublicClient;
    await expect(assertChainId(broken, 1)).rejects.toThrow(/rpc down/);
  });
});
