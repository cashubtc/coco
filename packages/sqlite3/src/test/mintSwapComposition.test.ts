import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRepositories } from '../index.ts';
import { runMintSwapCoordinatorContract } from '../../../adapter-tests/src/internal/mintSwap/coordinator.ts';
import { runMintSwapTransitionContract } from '../../../adapter-tests/src/internal/mintSwap/transitions.ts';

async function createRepositories() {
  const directory = await mkdtemp(join(tmpdir(), 'coco-mint-swap-'));
  const filename = join(directory, 'wallet.sqlite');
  let database = new Database(filename);
  return {
    repositories: new SqliteRepositories({ database, mintSwap: true }),
    reopen: async () => {
      database.close();
      database = new Database(filename);
      const repositories = new SqliteRepositories({ database, mintSwap: true });
      await repositories.init();
      return repositories;
    },
    dispose: async () => {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const runner = { describe, it, expect, beforeEach, afterEach };
runMintSwapCoordinatorContract({ createRepositories, supportsReopen: true }, runner);
runMintSwapTransitionContract({ createRepositories, supportsReopen: true }, runner);
