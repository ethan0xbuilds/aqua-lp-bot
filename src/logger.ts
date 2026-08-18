import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 极简结构化日志：控制台 + logs/app-YYYY-MM-DD.log 滚动文件。
 * 无外部依赖；无 Telegram 通知（用户要求）。
 */
export class Logger {
  private filePath: string;

  constructor(private level: Level = 'info', logDir = 'logs') {
    mkdirSync(logDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.filePath = join(logDir, `app-${day}.log`);
  }

  private write(level: Level, msg: string, meta?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}${meta !== undefined ? ' ' + JSON.stringify(meta) : ''}`;
    console[level === 'debug' ? 'log' : level](line);
    appendFileSync(this.filePath, line + '\n');
  }

  debug(msg: string, meta?: unknown): void { this.write('debug', msg, meta); }
  info(msg: string, meta?: unknown): void { this.write('info', msg, meta); }
  warn(msg: string, meta?: unknown): void { this.write('warn', msg, meta); }
  error(msg: string, meta?: unknown): void { this.write('error', msg, meta); }
}
