/**
 * 价格源接口：返回 1 枚 1INCH 兑多少 USDT。
 * 未来可替换为 swapVm.quote 等其他实现。
 */
export interface PriceSource {
  getPrice(): Promise<number>;
}
