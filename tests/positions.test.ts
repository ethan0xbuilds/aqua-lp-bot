import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

  it('bySide 按侧过滤并按开仓时间升序', () => {
    const p1 = makePosition({ side: 'inch', openedAtMs: 300 });
    const p2 = makePosition({ side: 'inch', openedAtMs: 100 });
    const p3 = makePosition({ side: 'usdt', openedAtMs: 200 });
    expect(bySide([p1, p2, p3], 'inch')).toEqual([p2, p1]);
    expect(bySide([p1, p2, p3], 'usdt')).toEqual([p3]);
  });
});
