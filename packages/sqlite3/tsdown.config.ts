import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['./index.ts'],
    platform: 'node',
    target: 'esnext',
    dts: true,
    format: ['esm', 'cjs'],
  },
]);
