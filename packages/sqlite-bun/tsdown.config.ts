import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts', './src/internal.ts'],
  format: ['esm'],
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['node:fs'],
});
