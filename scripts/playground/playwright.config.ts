import { defineConfig } from '@playwright/test';
import path from 'node:path';
const port = Number(process.env.PLAYGROUND_TEST_PORT ?? 5173);
export default defineConfig({
  testDir: './browser-test',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  outputDir: '../../test-results/playground',
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
  },
  webServer: {
    cwd: path.resolve(__dirname, '../..'),
    command:
      process.env.PLAYGROUND_DEV_TEST === '1'
        ? `bunx vite --config scripts/playground/vite.config.ts --mode test --port ${port}`
        : `bun run playground:build --mode test && bunx vite preview --config scripts/playground/vite.config.ts --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 180000,
  },
});
