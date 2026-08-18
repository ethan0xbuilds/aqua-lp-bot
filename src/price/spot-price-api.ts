import type { PriceSource } from './price-source.js';

const API_BASE = 'https://api.1inch.dev/price/v1.0';

/** 与 executor.withRetry 同口径：重试 2 次（共 3 次尝试）后才算失败 */
const MAX_ATTEMPTS = 3;
/** 短 backoff（250ms × attempt），避免瞬时抖动 1:1 计入熔断 */
const BACKOFF_MS = 250;

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

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
    private sleepFn: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /**
   * 内部 3 次尝试：网络抖动/瞬时 5xx 短 backoff 重试后才抛错。
   * 抛错才会被主循环 1:1 计入熔断——零重试的价格源会把瞬时故障直接喂给熔断。
   */
  async getPrice(): Promise<number> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const [inchUsd, usdtUsd] = await Promise.all([
          this.fetchUsd(this.opts.tokenInch),
          this.fetchUsd(this.opts.tokenUsdt),
        ]);
        return inchUsd / usdtUsd;
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_ATTEMPTS - 1) await this.sleepFn(BACKOFF_MS * (attempt + 1));
      }
    }
    throw lastErr;
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
