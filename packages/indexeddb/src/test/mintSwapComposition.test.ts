import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbRepositories } from '../index.ts';
import { runMintSwapCoordinatorContract } from '../../../adapter-tests/src/internal/mintSwap/coordinator.ts';
import { runMintSwapTransitionContract } from '../../../adapter-tests/src/internal/mintSwap/transitions.ts';

async function createRepositories() {
  const name = `mint-swap-composition-${crypto.randomUUID()}`;
  let repositories = new IndexedDbRepositories({ name, mintSwap: true });
  return {
    repositories,
    reopen: async () => {
      repositories.db.close();
      repositories = new IndexedDbRepositories({ name, mintSwap: true });
      await repositories.init();
      return repositories;
    },
    dispose: async () => repositories.db.delete(),
  };
}
const runner = { describe, it, expect, beforeEach, afterEach };
runMintSwapCoordinatorContract({ createRepositories, supportsReopen: true }, runner);
runMintSwapTransitionContract({ createRepositories, supportsReopen: true }, runner);
