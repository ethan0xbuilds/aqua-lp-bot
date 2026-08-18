/**
 * Aqua SDK 的薄封装：全项目只有这一个文件 import @1inch/* 包。
 * 换 SDK 版本/接口时只需改这里。
 * 真实 SDK 签名、精度格式与踩坑记录见 docs/SDK_NOTES.md。
 */
import { randomBytes } from 'node:crypto';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ABI,
  Address,
  AquaProtocolContract,
  AQUA_CONTRACT_ADDRESSES,
  HexString,
  NetworkEnum,
} from '@1inch/aqua-sdk';
import {
  AQUA_SWAP_VM_CONTRACT_ADDRESSES,
  AquaXYCAmmStrategy,
  instructions,
  MakerTraits,
  Order,
} from '@1inch/swap-vm-sdk';
import type { Config } from './config.js';
import type { NewPosition } from './types.js';

/** 一次链上交易请求（viem 兼容） */
export interface TxRequest {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

/** ship 的计划产物：交易 + 新仓位的 strategyHash（SDK 预测值） */
export interface ShipPlan {
  tx: TxRequest;
  strategyHash: `0x${string}`;
}

/**
 * Aqua SDK 的薄封装：全项目只有这一个文件 import @1inch/* 包。
 * 换 SDK 版本/接口时只需改这里。
 */
export interface AquaClient {
  /** 构建 ship 交易：按 NewPosition 编码策略程序并预测 strategyHash */
  buildShip(pos: NewPosition, walletAddress: `0x${string}`): Promise<ShipPlan>;
  /** 构建 dock 交易 */
  buildDock(strategyHash: `0x${string}`, tokenAddress: `0x${string}`): Promise<TxRequest>;
  /** 读取仓位剩余虚拟余额（原生单位），用于空壳判定与对账 */
  getRemaining(strategyHash: `0x${string}`, tokenAddress: `0x${string}`): Promise<bigint>;
}

export async function createAquaClient(cfg: Config): Promise<AquaClient> {
  // 注册表与路由器地址表按链 ID 索引（SDK_NOTES Q7），未覆盖的链直接拒绝
  const network = cfg.chainId as NetworkEnum;
  const registry = AQUA_CONTRACT_ADDRESSES[network];
  const router = AQUA_SWAP_VM_CONTRACT_ADDRESSES[network];
  if (registry === undefined || router === undefined) {
    throw new Error(`不支持的 chainId: ${cfg.chainId}（SDK 地址表仅覆盖 NetworkEnum 覆盖的链）`);
  }

  // maker 地址由私钥推导（rawBalances 查询用）
  const walletAddress = privateKeyToAccount(cfg.privateKey).address;

  // 只读客户端（getRemaining 用），不发交易
  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });

  // 价格口径：P = USDT per 1INCH。地址序 1INCH < USDT → tokenLt=1INCH、tokenGt=USDT，
  // 合约 P = tokenGt/tokenLt 恰与项目口径一致（SDK_NOTES Q4.3）
  const pricePair = {
    quoteToken: { address: new Address(cfg.tokenUsdt), decimals: BigInt(cfg.tokenUsdtDecimals) },
    baseToken: { address: new Address(cfg.tokenInch), decimals: BigInt(cfg.tokenInchDecimals) },
  };

  /** side → 该侧代币地址（brief：inch → tokenInch，否则 tokenUsdt） */
  function tokenFor(side: NewPosition['side']): `0x${string}` {
    return side === 'inch' ? cfg.tokenInch : cfg.tokenUsdt;
  }

  /** 人类价格（USDT/1INCH）→ 链上 1e18 定点 sqrt 价格（SDK 内部处理 decimals 换算） */
  function toSqrt(price: number): bigint {
    return instructions.concentrate.Price.fromHuman(String(price), pricePair).toSqrt();
  }

  return {
    async buildShip(pos, maker): Promise<ShipPlan> {
      const sqrtPriceMin = toSqrt(pos.lower);
      const sqrtPriceMax = toSqrt(pos.upper);
      if (sqrtPriceMin >= sqrtPriceMax) {
        throw new Error(
          `无效价格区间 lower=${pos.lower} upper=${pos.upper}：` +
            `编码后 sqrtPriceMin(${sqrtPriceMin}) 必须小于 sqrtPriceMax(${sqrtPriceMax})`,
        );
      }

      // 随机 salt：相同 strategy 字节 = 相同 strategyHash，重复 ship 会被链上
      // StrategiesMustBeImmutable 拒绝（dock 后同样永久占用），必须每次唯一（SDK_NOTES Q3/Q4）。
      // 注意 SDK 的 SaltArgs 只接受 uint64（0 <= salt <= 2^64-1，编码为 8 字节），
      // 因此用 8 字节随机数；2^64 空间对本 bot 足够
      const salt = BigInt('0x' + randomBytes(8).toString('hex'));

      const program = AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin, sqrtPriceMax })
        .withSalt(salt)
        .build();
      const order = Order.new({
        maker: new Address(maker),
        program,
        traits: MakerTraits.default(), // Aqua 模式（useAquaInsteadOfSignature）
      });
      const strategy = order.encode();

      // 预测 strategyHash = keccak256(strategy)，与链上 ship 的返回值一致
      const strategyHash = AquaProtocolContract.calculateStrategyHash(strategy)
        .toString() as `0x${string}`;

      const tx = AquaProtocolContract.buildShipTx(registry, {
        app: router,
        strategy,
        amountsAndTokens: [{ token: new Address(tokenFor(pos.side)), amount: pos.tokenAmount }],
      });

      return { tx: { to: tx.to, data: tx.data, value: tx.value }, strategyHash };
    },

    async buildDock(strategyHash, tokenAddress): Promise<TxRequest> {
      const tx = AquaProtocolContract.buildDockTx(registry, {
        app: router,
        strategyHash: new HexString(strategyHash),
        tokens: [new Address(tokenAddress)],
      });
      return { to: tx.to, data: tx.data, value: tx.value };
    },

    async getRemaining(strategyHash, tokenAddress): Promise<bigint> {
      // rawBalances(maker, app, strategyHash, token) view returns (uint248 balance, uint8 tokensCount)
      // balance 即该仓位的剩余虚拟余额（ship 登记、push/pull 增减），见 SDK_NOTES Q6
      const [balance] = (await publicClient.readContract({
        address: registry.toString(),
        abi: ABI.AQUA_ABI,
        functionName: 'rawBalances',
        args: [walletAddress, router.toString(), strategyHash, tokenAddress],
      })) as [bigint, number];
      return balance;
    },
  };
}
