import { describe, expect, it } from 'bun:test';
import { runKeyRingAllocationRepositoryContract } from '@cashu/coco-adapter-tests';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type { RepositoryTransactionScope } from '../../repositories/index.ts';

async function createRepositories() {
  const repositories = new MemoryRepositories();
  await repositories.init();
  return {
    repositories,
    dispose: async () => {},
  };
}

runKeyRingAllocationRepositoryContract({ createRepositories }, { describe, it, expect });

function assertAllocationIsRootOnly(scope: RepositoryTransactionScope): void {
  // @ts-expect-error Irreversible allocation must not be available inside a caller transaction.
  void scope.keyRingRepository.reserveNextDerivationIndex;
}

void assertAllocationIsRootOnly;
