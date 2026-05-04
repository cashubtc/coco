import { defineConfig } from 'vitest/config';

// Determine which browsers to test based on environment
// In CI, test all browsers. Locally, default to just chromium for speed.
const browserNames = process.env.VITEST_BROWSER
  ? process.env.VITEST_BROWSER.split(',').map((browser) => browser.trim())
  : process.env.CI
    ? ['chromium', 'firefox', 'webkit']
    : ['chromium'];

const browsers = browserNames
  .filter((browser) => browser.length > 0)
  .map((browser) => ({ browser }));

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
