import { describe, it, beforeEach, afterEach, expect as bunExpect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runIntegrationTests, type IntegrationTestRunner } from 'coco-cashu-adapter-tests';
import { SqliteRepositories } from '../index.ts';
import { ConsoleLogger, type Logger } from 'coco-cashu-core';

// Cast bun's expect to match the adapter-tests expectation type
const expect = bunExpect as unknown as IntegrationTestRunner['expect'];

const mintUrl = process.env.MINT_URL;

if (!mintUrl) {
  throw new Error('MINT_URL is not set');
}

function getTestLogger(): Logger | undefined {
  const logLevel = process.env.TEST_LOG_LEVEL;
  if (logLevel && ['error', 'warn', 'info', 'debug'].includes(logLevel)) {
    return new ConsoleLogger('sqlite-bun-integration', {
      level: logLevel as 'error' | 'warn' | 'info' | 'debug',
    });
  }
  return undefined;
}

async function createRepositories() {
  const database = new Database(':memory:');
  const repositories = new SqliteRepositories({ database });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      repositories.db.close();
    },
  };
}

runIntegrationTests(
  {
    createRepositories,
    mintUrl,
    logger: getTestLogger(),
    suiteName: 'SQLite Bun Integration Tests',
  },
  { describe, it, beforeEach, afterEach, expect },
);
