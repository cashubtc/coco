import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['./index.ts', './internal.ts'],
    platform: 'browser',
    target: 'esnext',
    dts: true,
    format: ['esm'],
  },
]);
