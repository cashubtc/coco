import { describe, expect, it } from 'bun:test';
import {
  runMintIssuanceAttemptRepositoryContract,
  runMintIssuanceProvenanceRepositoryContract,
  runRepositoryTransactionContract,
} from '@cashu/coco-adapter-tests';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

async function createRepositories() {
  const repositories = new MemoryRepositories();
  await repositories.init();
  return {
    repositories,
    dispose: async () => {},
  };
}

runMintIssuanceAttemptRepositoryContract({ createRepositories }, { describe, it, expect });
runMintIssuanceProvenanceRepositoryContract({ createRepositories }, { describe, it, expect });
runRepositoryTransactionContract(
  { createRepositories, testConcurrentRootOperationIsolation: true },
  { describe, it, expect },
);
