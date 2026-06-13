import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts', './src/test/index.ts'],
  format: ['esm'],
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
});
