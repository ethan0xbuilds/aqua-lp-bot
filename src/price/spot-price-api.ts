import type { PriceSource } from './price-source.js';

const API_BASE = 'https://api.1inch.dev/price/v1.0';

export interface SpotPriceApiOptions {
  apiKey: string;
  tokenInch: `0x${string}`;
  tokenUsdt: `0x${string}`;
  chainId: number;
}

/**
 * 1inch Spot Price API（与 Aqua 页面显示价格同源）。
 * 文档：https://business.1inch.com/portal/documentation/overview/products
 * key 申请：https://portal.1inch.dev
 */
export class SpotPriceApi implements PriceSource {
  constructor(
    private opts: SpotPriceApiOptions,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async getPrice(): Promise<number> {
    const [inchUsd, usdtUsd] = await Promise.all([
      this.fetchUsd(this.opts.tokenInch),
      this.fetchUsd(this.opts.tokenUsdt),
    ]);
    return inchUsd / usdtUsd;
  }

  private async fetchUsd(token: `0x${string}`): Promise<number> {
    const url = `${API_BASE}/${this.opts.chainId}/${token.toLowerCase()}?currency=USD`;
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    });
    if (!res.ok) throw new Error(`Spot Price API 请求失败: HTTP ${res.status}`);
    const data = (await res.json()) as { usd?: number };
    if (typeof data.usd !== 'number') throw new Error('Spot Price API 响应缺少 usd 字段');
    return data.usd;
  }
}
