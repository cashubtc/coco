import { describe, expect, it } from 'bun:test';
import { runRepositoryTransactionContract } from '@cashu/coco-adapter-tests';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

async function createRepositories() {
  return {
    repositories: new MemoryRepositories(),
    dispose: async () => {},
  };
}

async function createSharedRepositories() {
  const repositories = new MemoryRepositories();
  return {
    first: repositories,
    second: repositories,
    dispose: async () => {},
  };
}

runRepositoryTransactionContract(
  {
    createRepositories,
    createSharedRepositories,
    testConcurrentRootOperationIsolation: true,
  },
  { describe, it, expect },
);
