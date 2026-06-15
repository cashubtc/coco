import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
  alias: {
    '@cashu/coco-sql-storage': '../sql-storage/src/index.ts',
  },
  noExternal: ['@cashu/coco-sql-storage'],
});
