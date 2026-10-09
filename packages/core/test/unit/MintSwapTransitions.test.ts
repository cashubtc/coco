import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { runMintSwapTransitionContract } from '../../../adapter-tests/src/internal/mintSwap/transitions.ts';

runMintSwapTransitionContract(
  {
    createRepositories: async () => ({
      repositories: new MemoryRepositories({ mintSwap: true }),
      dispose: async () => {},
    }),
  },
  { describe, it, expect, beforeEach, afterEach },
);
