import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { runIntegrationTests } from 'coco-cashu-adapter-tests';
import { IndexedDbRepositories } from '../index.ts';
import { ConsoleLogger, type Logger, type LogLevel } from 'coco-cashu-core';

const mintUrl = import.meta.env.VITE_MINT_URL || 'http://localhost:3338';

if (!mintUrl) {
  throw new Error('VITE_MINT_URL is not set');
}

function getTestLogger(): Logger | undefined {
  const logLevel = import.meta.env.VITE_TEST_LOG_LEVEL;
  if (logLevel && ['error', 'warn', 'info', 'debug'].includes(logLevel)) {
    return new ConsoleLogger('indexeddb-integration', { level: logLevel as LogLevel });
  }
  return undefined;
}

let dbCounter = 0;

async function createRepositories() {
  // Use unique database name for each test to avoid conflicts
  const dbName = `coco_cashu_test_${Date.now()}_${dbCounter++}`;
  const repositories = new IndexedDbRepositories({ name: dbName });
  await repositories.init();
  return {
    repositories,
    // No cleanup needed - each test uses a unique database name and
    // the browser session is ephemeral (Playwright closes it after tests)
    dispose: async () => {},
  };
}

runIntegrationTests(
  {
    createRepositories,
    mintUrl,
    logger: getTestLogger(),
    suiteName: 'IndexedDB Integration Tests',
  },
  { describe, it, beforeEach, afterEach, expect },
);
