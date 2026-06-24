import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['./index.ts', './plugin.ts'],
    platform: 'neutral',
    target: 'esnext',
    format: ['esm'],
  },
]);
