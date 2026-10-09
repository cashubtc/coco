import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRepositories, type SqliteRepositoriesOptions } from '../index.ts';
import { NativeExpoSqliteDatabaseShim, WebExpoSqliteDatabaseShim } from './databaseShim.ts';
import { runMintSwapCoordinatorContract } from '../../../adapter-tests/src/internal/mintSwap/coordinator.ts';
import { runMintSwapTransitionContract } from '../../../adapter-tests/src/internal/mintSwap/transitions.ts';

for (const [name, Shim] of [
  ['native API shim', NativeExpoSqliteDatabaseShim],
  ['web API shim', WebExpoSqliteDatabaseShim],
] as const) {
  describe(name, () => {
    async function createRepositories() {
      const descriptors = ['window', 'document'].map(
        (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
      );
      if (Shim === WebExpoSqliteDatabaseShim) {
        Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
        Object.defineProperty(globalThis, 'document', { value: {}, configurable: true });
      }
      const directory = await mkdtemp(join(tmpdir(), 'coco-mint-swap-'));
      const filename = join(directory, 'wallet.sqlite');
      let database = new Shim(filename);
      return {
        repositories: new SqliteRepositories({
          database: database as unknown as SqliteRepositoriesOptions['database'],
          mintSwap: true,
        }),
        reopen: async () => {
          await database.closeAsync();
          database = new Shim(filename);
          const repositories = new SqliteRepositories({
            database: database as unknown as SqliteRepositoriesOptions['database'],
            mintSwap: true,
          });
          await repositories.init();
          return repositories;
        },
        dispose: async () => {
          await database.closeAsync();
          await rm(directory, { recursive: true, force: true });
          for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
          }
        },
      };
    }

    const runner = { describe, it, expect, beforeEach, afterEach };
    runMintSwapCoordinatorContract({ createRepositories, supportsReopen: true }, runner);
    runMintSwapTransitionContract({ createRepositories, supportsReopen: true }, runner);
  });
}
