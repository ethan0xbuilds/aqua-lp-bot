import { defineConfig } from 'vitest/config';

/** vitest 配置：测试文件集中在 tests/ 目录，命名 *.test.ts */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
