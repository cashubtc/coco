import { describe, expect, it } from 'bun:test';
import { runHistoryProjectionContract } from '@cashu/coco-adapter-tests';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

runHistoryProjectionContract(
  {
    createRepositories: async () => ({
      repositories: new MemoryRepositories(),
      dispose: async () => {},
    }),
  },
  { describe, it, expect },
);
