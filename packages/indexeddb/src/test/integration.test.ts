import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { runIntegrationTests } from 'coco-cashu-adapter-tests';
import { IndexedDbRepositories } from '../index.ts';
import { ConsoleLogger } from 'coco-cashu-core';

const mintUrl = process.env.MINT_URL;

if (!mintUrl) {
  throw new Error('MINT_URL is not set');
}

let testDbCounter = 0;

async function createRepositories() {
  const dbName = `coco_cashu_test_${Date.now()}_${testDbCounter++}`;
  const repositories = new IndexedDbRepositories({ name: dbName });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      // IndexedDB doesn't have a close method, but we can delete the database
      await repositories.db.delete();
    },
  };
}

runIntegrationTests(
  {
    createRepositories,
    mintUrl,
    logger: new ConsoleLogger('indexeddb-integration', { level: 'info' }),
  },
  { describe, it, beforeEach, afterEach, expect },
);

