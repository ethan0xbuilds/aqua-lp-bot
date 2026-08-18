import { defineConfig } from 'vitest/config';

/** vitest 配置：测试文件集中在 tests/ 目录，命名 *.test.ts */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    server: {
      deps: {
        // 1inch SDK 打包产物内部存在无扩展名 import（@1inch/byte-utils），
        // 原生 Node ESM 解析会失败（见 docs/SDK_NOTES.md 第 8.4 节），
        // 必须由 vite 内联处理这几个包才能解析
        inline: ['@1inch/swap-vm-sdk', '@1inch/aqua-sdk', '@1inch/sdk-core', '@1inch/byte-utils'],
      },
    },
  },
});
