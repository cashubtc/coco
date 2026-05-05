import { defineConfig } from 'vitest/config';

const configuredBrowsers = process.env.INDEXEDDB_TEST_BROWSERS?.split(',')
  .map((browser) => browser.trim())
  .filter(Boolean);

// Determine which browsers to test based on environment
// In CI, test all browsers unless INDEXEDDB_TEST_BROWSERS is set.
// Locally, default to just chromium for speed.
const defaultBrowsers = process.env.CI ? ['chromium', 'firefox', 'webkit'] : ['chromium'];
const browserNames = configuredBrowsers?.length ? configuredBrowsers : defaultBrowsers;
const browsers = browserNames.map((browser) => ({ browser }));

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
