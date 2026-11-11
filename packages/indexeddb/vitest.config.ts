import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import type { BrowserInstanceOption } from 'vitest/node';

// Determine which browsers to test based on environment
// In CI, test all browsers. Locally, default to just chromium for speed.
const browsers: BrowserInstanceOption[] = process.env.CI
  ? [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }]
  : [{ browser: 'chromium' }];

export default defineConfig({
  resolve: { alias: { '@core': decodeURIComponent(new URL('../core', import.meta.url).pathname) } },
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: browsers,
      headless: true,
      screenshotFailures: false,
    },
    include: ['src/test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
