import { defineConfig } from 'tsdown';

const sqlStorageEntry = new URL('../sql-storage/src/index.ts', import.meta.url).pathname;

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
  alias: {
    '@cashu/coco-sql-storage': sqlStorageEntry,
  },
  noExternal: ['@cashu/coco-sql-storage'],
});
