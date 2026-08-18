import { describe, expect, it, vi } from 'vitest';
import { Executor } from '../src/executor.js';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/logger.js';
import type { AquaClient, TxRequest } from '../src/aqua-client.js';
import type { NewPosition, Position } from '../src/types.js';

const cfg = loadConfig({
  PRIVATE_KEY: '0x' + '11'.repeat(32),
  RPC_URL: 'https://eth.example.com',
  API_KEY_1INCH: 'test-key',
} as NodeJS.ProcessEnv);

const silentLogger = new Logger('error', 'logs');
const WALLET = '0x' + '22'.repeat(20) as `0x${string}`;

function makeNewPos(over: Partial<NewPosition> = {}): NewPosition {
  return { side: 'inch', lower: 0.3, upper: 0.30012, tokenAmount: 20000n * 10n ** 18n, ...over };
}
function makePos(over: Partial<Position> = {}): Position {
  return {
    strategyHash: '0x' + 'ab'.repeat(32) as `0x${string}`,
    side: 'inch',
    tokenAddress: cfg.tokenInch,
    lower: 0.3,
    upper: 0.30012,
    allocatedUsd: 6000,
    remainingUsd: 6000,
    openedAtMs: 1_700_000_000_000,
    ...over,
  };
}

const TX: TxRequest = { to: '0x' + '33'.repeat(20) as `0x${string}`, data: '0xdeadbeef', value: 0n };

function makeMocks() {
  const buildShip = vi.fn().mockResolvedValue({ tx: TX, strategyHash: '0x' + 'ab'.repeat(32) as `0x${string}` });
  const buildDock = vi.fn().mockResolvedValue(TX);
  const aqua = { buildShip, buildDock } as unknown as AquaClient;
  const sendTransaction = vi.fn().mockResolvedValue('0x' + 'aa'.repeat(32) as `0x${string}`);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' });
  const wallet = { account: { address: WALLET }, sendTransaction } as never;
  const publicClient = { waitForTransactionReceipt } as never;
  const exec = new Executor(aqua, wallet, publicClient, silentLogger, cfg);
  return { exec, buildShip, buildDock, sendTransaction, waitForTransactionReceipt };
}

describe('Executor', () => {
  it('ship 广播交易、等待回执并返回 strategyHash', async () => {
    const { exec, buildShip, sendTransaction, waitForTransactionReceipt } = makeMocks();
    const hash = await exec.ship(makeNewPos());
    expect(hash).toBe('0x' + 'ab'.repeat(32));
    expect(buildShip).toHaveBeenCalledWith(expect.objectContaining({ side: 'inch' }), WALLET);
    expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: TX.to, data: TX.data }));
    expect(waitForTransactionReceipt).toHaveBeenCalled();
  });

  it('dock 调用 buildDock 并广播', async () => {
    const { exec, buildDock } = makeMocks();
    const p = makePos();
    await exec.dock(p.strategyHash, p.tokenAddress);
    expect(buildDock).toHaveBeenCalledWith(p.strategyHash, cfg.tokenInch);
  });

  it('网络错误自动重试，2 次后仍失败则抛出', async () => {
    vi.useFakeTimers(); // 消除重试真实 sleep 的抖动风险（vitest 5s 默认超时误杀过）
    const { exec, buildShip, sendTransaction } = makeMocks();
    sendTransaction
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'));
    const p = exec.ship(makeNewPos());
    const assertion = expect(p).rejects.toThrow(/network/); // 先挂处理器，避免假时钟推进期间的 unhandled rejection
    await vi.runAllTimersAsync();
    await assertion;
    expect(sendTransaction).toHaveBeenCalledTimes(3); // 1 次 + 2 重试
    expect(buildShip).toHaveBeenCalledTimes(1); // 重试绝不重建 ship（随机 salt 幂等防线）
    vi.useRealTimers();
  });

  it('重试后成功（第 2 次成功）', async () => {
    vi.useFakeTimers();
    const { exec, buildShip, sendTransaction } = makeMocks();
    sendTransaction.mockRejectedValueOnce(new Error('network'));
    const p = exec.ship(makeNewPos());
    await vi.runAllTimersAsync();
    await p;
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(buildShip).toHaveBeenCalledTimes(1); // 重试绝不重建 ship（随机 salt 幂等防线）
    vi.useRealTimers();
  });

  it('回执 status=reverted 时 ship/dock 均拒绝（revert 不算成功，防幻影仓位）', async () => {
    vi.useFakeTimers();
    const { exec, waitForTransactionReceipt } = makeMocks();
    waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    const shipP = exec.ship(makeNewPos());
    const handledShip = shipP.catch((e) => e); // 先挂处理器，避免假时钟推进期间的 unhandled rejection
    await vi.runAllTimersAsync();
    const shipErr = await handledShip;
    expect(String(shipErr)).toMatch(/reverted/);
    expect(String(shipErr)).toContain('0x' + 'aa'.repeat(32)); // 错误信息含 tx hash
    const dockP = exec.dock(makePos().strategyHash, makePos().tokenAddress);
    const handledDock = dockP.catch((e) => e);
    await vi.runAllTimersAsync();
    const dockErr = await handledDock;
    expect(String(dockErr)).toMatch(/reverted/);
    vi.useRealTimers();
  });

  it('dockAll 逐个平仓，单个失败不影响其余（best-effort）', async () => {
    vi.useFakeTimers(); // 消除重试真实 sleep 的抖动风险
    const { exec, buildDock, sendTransaction } = makeMocks();
    let calls = 0;
    sendTransaction.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return '0x' + 'aa'.repeat(32); // 第 1 个仓位成功
      throw new Error('revert'); // 第 2 个仓位全部重试失败
    });
    const positions = [makePos(), makePos({ strategyHash: '0x' + 'cd'.repeat(32) as `0x${string}` })];
    const p = exec.dockAll(positions); // 不抛错
    await vi.runAllTimersAsync();
    await p;
    expect(buildDock).toHaveBeenCalledTimes(2);
    expect(sendTransaction).toHaveBeenCalledTimes(4); // 1 成功 + 3 次失败重试
    vi.useRealTimers();
  });
});
