import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import sqlite3 from 'sqlite3';
import { runIntegrationTests } from 'coco-cashu-adapter-tests';
import { SqliteRepositories } from '../index.ts';
import { ConsoleLogger } from 'coco-cashu-core';

const mintUrl = process.env.MINT_URL;

if (!mintUrl) {
  throw new Error('MINT_URL is not set');
}

async function createRepositories() {
  const database = new sqlite3.Database(':memory:');
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
    logger: new ConsoleLogger('sqlite3-integration', { level: 'info' }),
  },
  { describe, it, beforeEach, afterEach, expect },
);

