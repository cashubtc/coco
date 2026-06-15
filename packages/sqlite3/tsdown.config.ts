import { defineConfig } from 'tsdown';

const sqlStorageEntry = new URL('../sql-storage/src/index.ts', import.meta.url).pathname;

export default defineConfig([
  {
    entry: ['./index.ts'],
    platform: 'neutral',
    target: 'esnext',
    dts: true,
    format: ['esm'],
    alias: {
      '@cashu/coco-sql-storage': sqlStorageEntry,
    },
    noExternal: ['@cashu/coco-sql-storage'],
  },
]);
