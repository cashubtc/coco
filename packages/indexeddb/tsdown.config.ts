import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['./index.ts'],
    platform: 'browser',
    target: 'esnext',
    dts: true,
    format: ['esm', 'cjs'],
  },
]);
