import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sqlStorageEntry = fileURLToPath(new URL('../sql-storage/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@cashu/coco-sql-storage': sqlStorageEntry,
    },
  },
  test: {
    include: ['src/test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
