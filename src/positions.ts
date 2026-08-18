import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Position, Side } from './types.js';

/**
 * 仓位状态表：Bot 开过的仓位（白名单）的本地持久化。
 * 文件：data/positions.json（gitignored）。重启进程不丢表。
 */
export class PositionsStore {
  constructor(private filePath: string) {}

  load(): Position[] {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as Position[];
    } catch (err) {
      // 白名单表损坏必须留痕（真钱安全）：记录原因后从空表开始，链上对账会补正
      console.warn('仓位表读取失败，从空表开始：', err);
      return [];
    }
  }

  save(positions: Position[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(positions, null, 2));
  }
}

/** 过滤出某方向的仓位，按开仓时间升序（index 0 最旧） */
export function bySide(positions: Position[], side: Side): Position[] {
  return positions
    .filter((p) => p.side === side)
    .sort((a, b) => a.openedAtMs - b.openedAtMs);
}
