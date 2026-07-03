import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const rootDir = import.meta.dirname;

export default defineConfig({
  root: rootDir,
  resolve: {
    alias: [
      { find: 'bun:test', replacement: resolve(rootDir, 'test/vitest-bun-test-shim.ts') },
      { find: /^@core\/(.+)$/, replacement: `${rootDir}/$1` },
      { find: '@core', replacement: rootDir },
    ],
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    exclude: ['test/integration/**'],
    globals: false,
  },
});
