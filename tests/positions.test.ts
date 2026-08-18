import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PositionsStore, bySide } from '../src/positions.js';
import type { Position } from '../src/types.js';

function makePosition(over: Partial<Position> = {}): Position {
  return {
    strategyHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    side: 'inch',
    tokenAddress: '0x111111111117dC0aa78b770fA6A738034120C302',
    lower: 0.3,
    upper: 0.30012,
    allocatedUsd: 6000,
    remainingUsd: 6000,
    openedAtMs: 1_700_000_000_000,
    ...over,
  };
}

describe('PositionsStore', () => {
  it('文件不存在时 load 返回空数组', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pos-'));
    const store = new PositionsStore(join(dir, 'positions.json'));
    expect(store.load()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('save 后 load 还原相同内容', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pos-'));
    const store = new PositionsStore(join(dir, 'positions.json'));
    const positions = [makePosition(), makePosition({ side: 'usdt', openedAtMs: 1_700_000_060_000 })];
    store.save(positions);
    expect(store.load()).toEqual(positions);
    rmSync(dir, { recursive: true, force: true });
  });

  it('save 原子写：不残留 .tmp 文件，且可覆盖旧内容', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pos-'));
    const path = join(dir, 'positions.json');
    const store = new PositionsStore(path);
    store.save([makePosition()]);
    store.save([]); // 覆盖为另一份内容
    expect(store.load()).toEqual([]);
    expect(existsSync(path + '.tmp')).toBe(false); // 临时文件已 rename 走
    rmSync(dir, { recursive: true, force: true });
  });

  it('load 剔除非法行（warn 留痕、不抛错），合法行不受影响', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pos-'));
    const store = new PositionsStore(join(dir, 'positions.json'));
    const good = makePosition();
    const badHash = makePosition({ strategyHash: 'not-a-hash' as `0x${string}` });
    const badAddr = makePosition({ tokenAddress: '0x1234' as `0x${string}` });
    const badSide = makePosition({ side: 'ether' as never });
    const badNum = makePosition({ remainingUsd: Number.NaN });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      store.save([good, badHash, badAddr, badSide, badNum]);
      const loaded = store.load();
      expect(loaded).toEqual([good]); // 4 行非法全剔除，合法行原样保留
      expect(warnSpy).toHaveBeenCalledTimes(4);
      expect(String(warnSpy.mock.calls[0][0])).toContain('strategyHash');
      expect(String(warnSpy.mock.calls[1][0])).toContain('tokenAddress');
      expect(String(warnSpy.mock.calls[2][0])).toContain('side');
      expect(String(warnSpy.mock.calls[3][0])).toContain('remainingUsd');
    } finally {
      warnSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('null/非对象行只剔除自己，不拖累合法行（不能整表退回空表）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pos-'));
    const store = new PositionsStore(join(dir, 'positions.json'));
    const good = makePosition();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      store.save([null, good, 'garbage', 42] as never); // 混合垃圾行 + 合法行
      expect(store.load()).toEqual([good]); // 合法行保留
      expect(warnSpy).toHaveBeenCalledTimes(3);
    } finally {
      warnSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('load 保留 DRY_RUN 占位行（dry-*，干跑模拟仓位上限需要）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pos-'));
    const store = new PositionsStore(join(dir, 'positions.json'));
    const dry = makePosition({ strategyHash: 'dry-1755555555555-inch' as `0x${string}` });
    const real = makePosition();
    store.save([dry, real]);
    expect(store.load().map((p) => p.strategyHash)).toEqual([dry.strategyHash, real.strategyHash]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('bySide 按侧过滤并按开仓时间升序', () => {
    const p1 = makePosition({ side: 'inch', openedAtMs: 300 });
    const p2 = makePosition({ side: 'inch', openedAtMs: 100 });
    const p3 = makePosition({ side: 'usdt', openedAtMs: 200 });
    expect(bySide([p1, p2, p3], 'inch')).toEqual([p2, p1]);
    expect(bySide([p1, p2, p3], 'usdt')).toEqual([p3]);
  });
});
