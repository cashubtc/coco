import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['./index.ts'],
    platform: 'neutral',
    target: 'esnext',
    dts: true,
    format: ['esm'],
    alias: {
      '@cashu/coco-sql-storage': '../sql-storage/src/index.ts',
    },
    noExternal: ['@cashu/coco-sql-storage'],
  },
]);
