import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../src/logger.js';

describe('smoke', () => {
  it('logger 能写入日志目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aqua-lp-bot-smoke-'));
    const day = new Date().toISOString().slice(0, 10);
    const logger = new Logger('debug', dir);
    logger.info('smoke test');
    // 断言真实行为：日志文件已生成且包含该行（写入临时目录，不在仓库留痕）
    const file = join(dir, `app-${day}.log`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('smoke test');
  });
});
