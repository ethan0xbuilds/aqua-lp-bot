import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ABI,
  AquaProtocolContract,
  AQUA_CONTRACT_ADDRESSES,
  Address,
  HexString,
  NetworkEnum,
} from '@1inch/aqua-sdk';
import {
  AQUA_SWAP_VM_CONTRACT_ADDRESSES,
  instructions,
  Order,
} from '@1inch/swap-vm-sdk';

import { loadConfig, type Config } from '../src/config.js';
import type { NewPosition } from '../src/types.js';
import { createAquaClient, type AquaClient } from '../src/aqua-client.js';

// 仅 mock viem 的 RPC 客户端：getRemaining 的 rawBalances 只读调用不发真实请求
const readContractMock = vi.hoisted(() => vi.fn());
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    http: () => ({ transport: 'stub' }),
    createPublicClient: () => ({ readContract: readContractMock }),
  };
});

const BASE_ENV = {
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv;

const cfg: Config = loadConfig(BASE_ENV);
const WALLET = privateKeyToAccount(cfg.privateKey).address;
const REGISTRY = AQUA_CONTRACT_ADDRESSES[NetworkEnum.ETHEREUM].toString();
const ROUTER = AQUA_SWAP_VM_CONTRACT_ADDRESSES[NetworkEnum.ETHEREUM].toString();

/** 交易对价格口径：P = USDT per 1INCH（quoteToken=USDT、baseToken=1INCH） */
const PAIR = {
  quoteToken: { address: new Address(cfg.tokenUsdt), decimals: BigInt(cfg.tokenUsdtDecimals) },
  baseToken: { address: new Address(cfg.tokenInch), decimals: BigInt(cfg.tokenInchDecimals) },
};

/** 从 ship calldata 中解出 strategy 字节 */
function strategyOf(data: `0x${string}`): string {
  const decoded = decodeFunctionData({ abi: ABI.AQUA_ABI, data });
  expect(decoded.functionName).toBe('ship');
  const args = decoded.args as unknown as readonly [string, string, string[], bigint[]];
  return args[1];
}

describe('createAquaClient', () => {
  it('不支持的 chainId 直接抛错', async () => {
    await expect(createAquaClient({ ...cfg, chainId: 999999 })).rejects.toThrow(/chainId|不支持/);
  });
});

describe('buildShip', () => {
  let client: AquaClient;

  beforeEach(async () => {
    client = await createAquaClient(cfg);
  });

  it('inch 侧：编码 ship(app=router, tokens=[1INCH], amounts=[tokenAmount])，strategyHash=keccak(strategy)', async () => {
    const pos: NewPosition = { side: 'inch', lower: 0.25, upper: 0.25015, tokenAmount: 1000n * 10n ** 18n };
    const plan = await client.buildShip(pos, WALLET);

    // 交易目标 = Aqua 注册表，value=0（ship 不转账，只登记虚拟余额）
    expect(plan.tx.to).toBe(REGISTRY);
    expect(plan.tx.value).toBe(0n);

    const decoded = decodeFunctionData({ abi: ABI.AQUA_ABI, data: plan.tx.data });
    const args = decoded.args as unknown as readonly [string, string, string[], bigint[]];
    expect(decoded.functionName).toBe('ship');
    expect(args[0].toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(args[2].map((t) => t.toLowerCase())).toEqual([cfg.tokenInch.toLowerCase()]);
    expect(args[3]).toEqual([pos.tokenAmount]);

    // strategyHash：格式、= keccak256(strategy)、= SDK 预测值（三者一致）
    const strategy = args[1];
    expect(plan.strategyHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(plan.strategyHash).toBe(keccak256(strategy as `0x${string}`));
    expect(plan.strategyHash).toBe(
      AquaProtocolContract.calculateStrategyHash(new HexString(strategy)).toString(),
    );

    // strategy 可回解为 Order：maker 正确；program = concentrate(2+64) + xycSwapXD(2) + salt(2+8) = 78 字节
    const order = Order.decode(new HexString(strategy));
    expect(order.maker.toString().toLowerCase()).toBe(WALLET.toLowerCase());
    expect(order.program.bytesCount()).toBe(78);
  });

  it('usdt 侧：tokens 映射为 USDT', async () => {
    const pos: NewPosition = { side: 'usdt', lower: 0.2001, upper: 0.25, tokenAmount: 250n * 10n ** 6n };
    const plan = await client.buildShip(pos, WALLET);

    const decoded = decodeFunctionData({ abi: ABI.AQUA_ABI, data: plan.tx.data });
    const args = decoded.args as unknown as readonly [string, string, string[], bigint[]];
    expect(args[2].map((t) => t.toLowerCase())).toEqual([cfg.tokenUsdt.toLowerCase()]);
    expect(args[3]).toEqual([250n * 10n ** 6n]);
  });

  it('区间上下限按 sqrt(P*1e18) 定点编码进程序（inch 侧 [0.25, 0.25015]）', async () => {
    const pos: NewPosition = { side: 'inch', lower: 0.25, upper: 0.25015, tokenAmount: 1n };
    const plan = await client.buildShip(pos, WALLET);
    const strategy = strategyOf(plan.tx.data);
    const order = Order.decode(new HexString(strategy));

    // program 字节结构：0x12 40 <sqrtPriceMin 32B> <sqrtPriceMax 32B> 11 00 14 08 <salt 8B>
    const lo = instructions.concentrate.Price.fromHuman(String(pos.lower), PAIR)
      .toSqrt()
      .toString(16)
      .padStart(64, '0');
    const hi = instructions.concentrate.Price.fromHuman(String(pos.upper), PAIR)
      .toSqrt()
      .toString(16)
      .padStart(64, '0');
    const programHex = order.program.toString();
    expect(programHex.slice(0, 2 + 2 + 2 + 128)).toBe('0x1240' + lo + hi);
  });

  it('usdt 侧区间同样按 sqrt 定点编码（[0.2001, 0.25]）', async () => {
    const pos: NewPosition = { side: 'usdt', lower: 0.2001, upper: 0.25, tokenAmount: 1n };
    const plan = await client.buildShip(pos, WALLET);
    const strategy = strategyOf(plan.tx.data);
    const order = Order.decode(new HexString(strategy));

    const lo = instructions.concentrate.Price.fromHuman(String(pos.lower), PAIR)
      .toSqrt()
      .toString(16)
      .padStart(64, '0');
    const hi = instructions.concentrate.Price.fromHuman(String(pos.upper), PAIR)
      .toSqrt()
      .toString(16)
      .padStart(64, '0');
    expect(order.program.toString().slice(0, 2 + 2 + 2 + 128)).toBe('0x1240' + lo + hi);
  });

  it('每次 buildShip 生成唯一 strategyHash（随机 salt 防重）', async () => {
    const pos: NewPosition = { side: 'inch', lower: 0.25, upper: 0.25015, tokenAmount: 1000n * 10n ** 18n };
    const p1 = await client.buildShip(pos, WALLET);
    const p2 = await client.buildShip(pos, WALLET);
    expect(p1.strategyHash).not.toBe(p2.strategyHash);
  });

  it('非法区间（lower >= upper）抛错', async () => {
    await expect(
      client.buildShip({ side: 'inch', lower: 0.3, upper: 0.3, tokenAmount: 1n }, WALLET),
    ).rejects.toThrow(/区间|lower|upper|sqrtPrice/i);
  });
});

describe('buildDock', () => {
  it('编码 dock(app=router, strategyHash, tokens=[token])', async () => {
    const client = await createAquaClient(cfg);
    const hash = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
    const tx = await client.buildDock(hash, cfg.tokenInch);

    expect(tx.to).toBe(REGISTRY);
    expect(tx.value).toBe(0n);

    const decoded = decodeFunctionData({ abi: ABI.AQUA_ABI, data: tx.data });
    expect(decoded.functionName).toBe('dock');
    const args = decoded.args as unknown as readonly [string, string, string[]];
    expect(args[0].toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(args[1]).toBe(hash);
    expect(args[2].map((t) => t.toLowerCase())).toEqual([cfg.tokenInch.toLowerCase()]);
  });
});

describe('getRemaining', () => {
  it('调用 rawBalances(maker, router, strategyHash, token) 并返回 { remaining, tokensCount }', async () => {
    readContractMock.mockReset();
    readContractMock.mockResolvedValue([1234n, 1]);

    const client = await createAquaClient(cfg);
    const hash = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
    const info = await client.getRemaining(hash, cfg.tokenInch);

    expect(info).toEqual({ remaining: 1234n, tokensCount: 1 }); // tokensCount 原样透传（死行判定用）
    expect(readContractMock).toHaveBeenCalledTimes(1);

    const callArgs = readContractMock.mock.calls[0][0] as {
      address: string;
      functionName: string;
      args: unknown[];
    };
    expect(callArgs.functionName).toBe('rawBalances');
    expect(callArgs.address.toLowerCase()).toBe(REGISTRY.toLowerCase());
    // maker 由 cfg.privateKey 推导（viem 返回 checksum 地址，直接与同源推导结果比对）
    expect(callArgs.args[0]).toBe(WALLET);
    expect((callArgs.args[1] as string).toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(callArgs.args[2]).toBe(hash);
    expect((callArgs.args[3] as string).toLowerCase()).toBe(cfg.tokenInch.toLowerCase());
  });
});

describe('区间方向编码回归锚（硬编码，防实现与测试同源漂移）', () => {
  it('0.2/0.25/0.3 → 固定 sqrt 定点编码值（实测值，勿随手改）', () => {
    // 2026-08-18 用已安装 SDK（@1inch/swap-vm-sdk@0.4.0 + @1inch/aqua-sdk@0.3.0）
    // 实测输出，PAIR 与 src/aqua-client.ts 的 pricePair 完全一致。
    // 注意与 docs/SDK_NOTES.md Q4.3 表格相差 1e9（SDK_NOTES 记录的是另一层缩放口径），
    // 以本测试的实际 SDK 输出为准。
    expect(instructions.concentrate.Price.fromHuman('0.2', PAIR).toSqrt()).toBe(447213595499n);
    expect(instructions.concentrate.Price.fromHuman('0.25', PAIR).toSqrt()).toBe(500000000000n);
    expect(instructions.concentrate.Price.fromHuman('0.3', PAIR).toSqrt()).toBe(547722557505n);
  });

  it('方向编码保持升序：upper > lower（inch 侧区间挂在当前价上方的前提）', () => {
    const lo = instructions.concentrate.Price.fromHuman('0.2', PAIR).toSqrt();
    const hi = instructions.concentrate.Price.fromHuman('0.20008', PAIR).toSqrt(); // +0.04% 宽度
    expect(hi).toBeGreaterThan(lo);
    // 0.2 → 0.20008 的编码增量与 0.2 的编码值一并锚定
    expect(lo).toBe(447213595499n);
    expect(hi).toBe(447303029276n);
  });
});
