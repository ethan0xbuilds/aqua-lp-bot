import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Position, Side } from './types.js';

/**
 * 仓位状态表：Bot 开过的仓位（白名单）的本地持久化。
 * 文件：data/positions.json（gitignored）。重启进程不丢表。
 */

const HEX_HASH = /^0x[0-9a-fA-F]{64}$/; // strategyHash：0x + 64 hex = 66 字符
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/; // tokenAddress：0x + 40 hex = 42 字符
const DRY_HASH = /^dry-\d+-(inch|usdt)$/; // DRY_RUN 占位行（干跑模拟仓位上限/二仓间隔需要它们，不能剔除）

/**
 * 行级校验：不合法行无法 dock，保留只会喂养熔断 dockAll 死循环（真钱安全），
 * 必须剔除。返回问题列表（空 = 合法）。
 */
function problemsOf(row: unknown): string[] {
  // null/数组/原始值等非对象行：直接判非法（不能在此抛错——抛错会被 load 的外层
  // catch 吞掉，导致整张表退回空表，连合法行一起丢失）
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    return ['非对象行'];
  }
  const p = row as Partial<Position>;
  const problems: string[] = [];
  if (typeof p.strategyHash !== 'string' || (!HEX_HASH.test(p.strategyHash) && !DRY_HASH.test(p.strategyHash))) {
    problems.push('strategyHash 非法');
  }
  if (typeof p.tokenAddress !== 'string' || !HEX_ADDR.test(p.tokenAddress)) {
    problems.push('tokenAddress 非法');
  }
  if (p.side !== 'inch' && p.side !== 'usdt') {
    problems.push('side 非法');
  }
  for (const k of ['lower', 'upper', 'allocatedUsd', 'remainingUsd', 'openedAtMs'] as const) {
    if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) {
      problems.push(`${k} 非法`);
    }
  }
  return problems;
}

export class PositionsStore {
  constructor(private filePath: string) {}

  load(): Position[] {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const valid: Position[] = [];
      for (const row of parsed) {
        const problems = problemsOf(row);
        if (problems.length > 0) {
          // 非法行剔除必须留痕：warn 注明原因与原始行内容
          console.warn(`仓位表剔除非法行（${problems.join('、')}）: ${JSON.stringify(row)}`);
        } else {
          valid.push(row as Position);
        }
      }
      return valid;
    } catch (err) {
      // 白名单表损坏必须留痕（真钱安全）：记录原因后从空表开始，链上对账会补正
      console.warn('仓位表读取失败，从空表开始：', err);
      return [];
    }
  }

  save(positions: Position[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // 原子写：先写 .tmp 再 rename 覆盖。中途崩溃只会留下完整旧表或完整新表，
    // 绝不会出现半截 JSON（表是 dock 白名单：损坏 = 熔断全平/对账全失效，必须防截断）
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(positions, null, 2));
    renameSync(tmpPath, this.filePath);
  }
}

/** 过滤出某方向的仓位，按开仓时间升序（index 0 最旧） */
export function bySide(positions: Position[], side: Side): Position[] {
  return positions
    .filter((p) => p.side === side)
    .sort((a, b) => a.openedAtMs - b.openedAtMs);
}
