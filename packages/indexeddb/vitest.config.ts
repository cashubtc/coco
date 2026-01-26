import { defineConfig } from 'vitest/config';

declare const process: { env: Record<string, string | undefined> };

// Determine which browsers to test based on environment
// In CI, test all browsers. Locally, default to just chromium for speed.
const browsers = process.env.CI
  ? [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }]
  : [{ browser: 'chromium' }];

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: 'playwright',
      instances: browsers as any,
      headless: true,
      screenshotFailures: false,
    },
    include: ['src/test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
