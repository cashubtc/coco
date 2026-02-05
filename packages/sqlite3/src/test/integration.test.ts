import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runIntegrationTests } from 'coco-cashu-adapter-tests';
import { SqliteRepositories } from '../index.ts';
import { ConsoleLogger, type Logger } from 'coco-cashu-core';

const mintUrl = process.env.MINT_URL;

if (!mintUrl) {
  throw new Error('MINT_URL is not set');
}

function getTestLogger(): Logger | undefined {
  const logLevel = process.env.TEST_LOG_LEVEL;
  if (logLevel && ['error', 'warn', 'info', 'debug'].includes(logLevel)) {
    return new ConsoleLogger('sqlite3-integration', {
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
      await repositories.db.close();
    },
  };
}

runIntegrationTests(
  {
    createRepositories,
    mintUrl,
    logger: getTestLogger(),
    suiteName: 'SQLite3 Integration Tests',
  },
  { describe, it, beforeEach, afterEach, expect },
);
