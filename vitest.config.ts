import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-home.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    // development rule (CLAUDE.md): tests never write into the live job; the product itself protects nothing by default
    env: { EDITMCP_PROTECTED_PATHS: 'D:\\261009_STB50Y_THAI-WORLD_CSR' },
  },
});
