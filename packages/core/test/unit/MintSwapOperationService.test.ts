import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { runMintSwapCoordinatorContract } from '../../../adapter-tests/src/internal/mintSwap/coordinator.ts';

runMintSwapCoordinatorContract(
  {
    createRepositories: async () => ({
      repositories: new MemoryRepositories({ mintSwap: true }),
      dispose: async () => {},
    }),
  },
  { describe, it, expect, beforeEach, afterEach },
);
