import { defineConfig } from 'vitest/config';

declare const process: {
  cwd(): string;
};

const sqlStorageEntry = `${process.cwd()}/../sql-storage/src/index.ts`;

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
