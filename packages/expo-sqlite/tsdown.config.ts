import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['./index.ts'],
    platform: 'neutral',
    target: 'esnext',
    dts: true,
    format: ['esm', 'cjs'],
  },
]);
