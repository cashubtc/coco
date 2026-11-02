import { describe, expect, it } from 'bun:test';
import { runBatchMintPersistenceContract } from '@cashu/coco-adapter-tests';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

runBatchMintPersistenceContract(
  {
    createRepositories: async () => ({
      repositories: new MemoryRepositories(),
      dispose: async () => {},
    }),
  },
  { describe, it, expect },
);
