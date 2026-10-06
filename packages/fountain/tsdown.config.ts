import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    './src/index.ts',
    './src/core.ts',
    './src/cashu.ts',
    './src/ur.ts',
    './src/encoding.ts',
    './src/auto.ts',
  ],
  format: ['esm'],
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
});
