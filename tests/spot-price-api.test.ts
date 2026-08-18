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
});
