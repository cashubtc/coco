import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@cashu/coco-sql-storage': '../sql-storage/src/index.ts',
    },
  },
  test: {
    include: ['src/test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
