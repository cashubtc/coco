import { describe, expect, it } from 'bun:test';
import {
  runMintSwapCapabilityAbsenceContract,
  runMintSwapRepositoryContract,
  runRepositoryTransactionContract,
} from '@cashu/coco-adapter-tests';

import type { Repositories, RepositoryTransactionScope } from '../../repositories';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories';

async function createRepositories() {
  return {
    repositories: new MemoryRepositories(),
    dispose: async () => {},
  };
}

async function createRepositoriesWithoutMintSwap() {
  const memory = new MemoryRepositories();
  const repositories = new Proxy(memory, {
    get(target, property, receiver) {
      if (property === 'mintSwap') return undefined;
      if (property === 'withTransaction') {
        return <T>(fn: (scope: RepositoryTransactionScope) => Promise<T>) =>
          target.withTransaction((scope) => fn(hideMintSwapCapability(scope)));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Repositories;
  return {
    repositories,
    dispose: async () => {},
  };
}

function hideMintSwapCapability(scope: RepositoryTransactionScope): RepositoryTransactionScope {
  return new Proxy(scope, {
    get(target, property, receiver) {
      if (property === 'mintSwap') return undefined;
      return Reflect.get(target, property, receiver);
    },
  });
}

runRepositoryTransactionContract(
  {
    createRepositories,
    testConcurrentRootOperationIsolation: true,
  },
  { describe, it, expect },
);

runMintSwapRepositoryContract({ createRepositories }, { describe, it, expect });

runMintSwapCapabilityAbsenceContract(
  { createRepositories: createRepositoriesWithoutMintSwap },
  { describe, it, expect },
);
