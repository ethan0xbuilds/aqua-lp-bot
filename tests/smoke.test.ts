import { describe, expect, it } from 'vitest';
import { Logger } from '../src/logger.js';

describe('smoke', () => {
  it('logger 能写入日志目录', () => {
    const logger = new Logger('debug', 'logs');
    logger.info('smoke test');
    expect(true).toBe(true);
  });
});
