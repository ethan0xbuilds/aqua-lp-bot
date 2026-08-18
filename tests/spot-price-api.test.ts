import { describe, expect, it, vi } from 'vitest';
import { SpotPriceApi } from '../src/price/spot-price-api.js';

const INCH_ADDR = '0x111111111117dC0aa78b770fA6A738034120C302';
const USDT_ADDR = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

function mockFetch(responses: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    const body = u.includes(INCH_ADDR.toLowerCase()) ? responses.inch : responses.usdt;
    return { ok: true, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

function makeApi(fetchFn: typeof fetch): SpotPriceApi {
  return new SpotPriceApi({ apiKey: 'key', tokenInch: INCH_ADDR, tokenUsdt: USDT_ADDR, chainId: 1 }, fetchFn);
}

describe('SpotPriceApi', () => {
  it('返回 1INCH/USDT 价格 = 两币 USD 价相除', async () => {
    const fetchFn = mockFetch({ inch: { usd: 0.3 }, usdt: { usd: 1.0 } });
    expect(await makeApi(fetchFn).getPrice()).toBeCloseTo(0.3, 10);
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const headers = calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer key');
  });

  it('USDT 不为 1 时也能正确相除', async () => {
    const fetchFn = mockFetch({ inch: { usd: 0.3 }, usdt: { usd: 0.998 } });
    expect(await makeApi(fetchFn).getPrice()).toBeCloseTo(0.3 / 0.998, 10);
  });

  it('HTTP 非 2xx 抛错', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 403 }) as Response) as unknown as typeof fetch;
    await expect(makeApi(fetchFn).getPrice()).rejects.toThrow(/403/);
  });

  it('响应缺少 usd 字段抛错', async () => {
    const fetchFn = mockFetch({ inch: {}, usdt: { usd: 1.0 } });
    await expect(makeApi(fetchFn).getPrice()).rejects.toThrow(/usd/);
  });

  it('瞬时失败两次后第三次成功 → 返回价格（3 次尝试 + 短 backoff，不计入熔断）', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      calls += 1;
      if (calls <= 4) throw new Error('network down'); // 前 2 次尝试（2 币 × 2 次）全败
      const u = String(url);
      return {
        ok: true,
        json: async () => ({ usd: u.includes(INCH_ADDR.toLowerCase()) ? 0.3 : 1.0 }),
      } as Response;
    }) as unknown as typeof fetch;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const price = await new SpotPriceApi(
      { apiKey: 'key', tokenInch: INCH_ADDR, tokenUsdt: USDT_ADDR, chainId: 1 },
      fetchFn,
      sleep,
    ).getPrice();
    expect(price).toBeCloseTo(0.3, 10);
    expect(calls).toBe(6); // 3 次尝试 × 2 币
    expect(sleep).toHaveBeenCalledTimes(2); // 仅失败后 backoff
    expect(sleep).toHaveBeenNthCalledWith(1, 250); // 250ms × 1
    expect(sleep).toHaveBeenNthCalledWith(2, 500); // 250ms × 2
  });

  it('三次全败 → 抛错（1:1 计入熔断的是 3 次尝试后的最终失败）', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      new SpotPriceApi(
        { apiKey: 'key', tokenInch: INCH_ADDR, tokenUsdt: USDT_ADDR, chainId: 1 },
        fetchFn,
        sleep,
      ).getPrice(),
    ).rejects.toThrow(/network down/);
    expect(fetchFn).toHaveBeenCalledTimes(6); // 重试到底，不提前放弃
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
