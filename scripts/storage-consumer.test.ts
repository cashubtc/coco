import { describe, expect, it } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';
import * as core from '../packages/core/dist/index.js';
import * as sql from '../packages/sql-storage/dist/index.js';
import { createSqliteStorage } from '../packages/sqlite-bun/dist/index.js';
import { createStorageHandle } from '../packages/core/dist/internal.js';
import { createBunSqlDatabase } from '../packages/sql-storage/src/test/bunSqlDatabase.ts';

const root = resolve(import.meta.dir, '..');
const seedGetter = async () => new Uint8Array(64).fill(7);
const background = {
  watchers: {
    mintOperationWatcher: { disabled: true },
    meltQuoteWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
    meltSettlementProcessor: { disabled: true },
  },
};

describe('built storage consumer compatibility', () => {
  it('supports official and independent SQLite drivers without exposing repositories', async () => {
    for (const factory of [
      createSqliteStorage,
      ({ database }: { database: Database }) =>
        sql.createSqliteStorage({ database: createBunSqlDatabase(database) }),
    ]) {
      const database = new Database(':memory:');
      try {
        const storage = factory({ database });
        expect('proofRepository' in storage).toBe(false);
        const manager = await core.initializeCoco({ storage, seedGetter, ...background });
        expect(await manager.wallet.balances.byUnit()).toEqual({});
        await manager.dispose();
      } finally {
        database.close();
      }
    }
    expect('MemoryRepositories' in core).toBe(false);
    expect('SqlStorageRepositories' in sql).toBe(false);
    expect('ensureSchema' in sql).toBe(false);
    expect(
      typeof (await import('../packages/sql-storage/dist/test/index.js')).runSqlDatabaseContract,
    ).toBe('function');
    expect(() =>
      Bun.resolveSync('@cashu/coco-core/adapter', join(root, 'packages/sql-storage')),
    ).toThrow();
  });

  it('interoperates with a second installation of the same core version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coco-consumer-'));
    try {
      await cp(join(root, 'packages/core/dist'), join(directory, 'dist'), { recursive: true });
      await cp(join(root, 'packages/core/package.json'), join(directory, 'package.json'));
      await symlink(join(root, 'packages/core/node_modules'), join(directory, 'node_modules'));
      const duplicate = await import(pathToFileURL(join(directory, 'dist/index.js')).href);
      const internals = await import(pathToFileURL(join(directory, 'dist/internal.js')).href);
      const storage = duplicate.createMemoryStorage();
      const manager = await core.initializeCoco({ storage, seedGetter, ...background });
      const keypair = await manager.keyring.generateKeyPair();
      await manager.dispose();
      const next = new duplicate.Manager(storage, seedGetter);
      expect((await next.keyring.getKeyPair(keypair.publicKeyHex))?.publicKeyHex).toBe(
        keypair.publicKeyHex,
      );
      await next.dispose();
      // Exercise retry classification across installed copies, not just successful reads.
      const repositories = new internals.MemoryRepositories();
      const transact = repositories.withTransaction.bind(repositories);
      let attempts = 0;
      repositories.withTransaction = async (work: unknown) => {
        if (++attempts === 1) throw new internals.RepositoryTransactionConflictError();
        return transact(work);
      };
      const retryStorage = internals.createStorageHandle(() => repositories);
      await retryStorage.init();
      const retrySession = new core.Manager(retryStorage, seedGetter);
      try {
        expect((await retrySession.keyring.generateKeyPair(true)).derivationIndex).toBe(0);
        expect(attempts).toBe(2);
      } finally {
        await retrySession.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects mismatched private integration before creating repositories or accessing a database', () => {
    let touched = false;
    expect(() =>
      createStorageHandle(() => {
        touched = true;
        throw new Error('database touched');
      }, 'incompatible-release'),
    ).toThrow('matching Coco package versions');
    expect(touched).toBe(false);
  });

  it('compiles supported consumers and rejects former repository setup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coco-consumer-types-'));
    try {
      await mkdir(join(directory, 'node_modules/@cashu'), { recursive: true });
      for (const [name, location] of [
        ['coco-core', 'core'],
        ['coco-sql-storage', 'sql-storage'],
      ]) {
        await symlink(
          join(root, 'packages', location!),
          join(directory, 'node_modules/@cashu', name!),
        );
      }
      await writeFile(
        join(directory, 'consumer.ts'),
        `
import { createMemoryStorage, initializeCoco, Manager, type CocoStorage, type ProofUnitFilter } from '@cashu/coco-core';
import { createSqliteStorage, SqlTransactionConflictError, type SqlDatabase } from '@cashu/coco-sql-storage';
import { runSqlDatabaseContract } from '@cashu/coco-sql-storage/test';
import type { Plugin } from '@cashu/coco-core/plugin';
// @ts-expect-error Repository construction is no longer public.
import { MemoryRepositories } from '@cashu/coco-core';
// @ts-expect-error The stable adapter entry point was retired in v3.
import type { Repositories } from '@cashu/coco-core/adapter';
// @ts-expect-error SQL repositories are internal.
import { SqlStorageRepositories } from '@cashu/coco-sql-storage';
const storage = createMemoryStorage();
const seedGetter = async () => new Uint8Array(64);
await storage.init();
new Manager(storage, seedGetter);
const plugin: Plugin<['proofService']> = { name: 'consumer', required: ['proofService'], async onInit(context) {
  const filter: ProofUnitFilter = { units: ['sat'] };
  await context.services.proofService.getAllReadyProofs(filter);
} };
await initializeCoco({ storage, seedGetter, plugins: [plugin] });
// @ts-expect-error Handles do not expose repositories.
storage.proofRepository;
// @ts-expect-error init alone does not implement opaque storage.
const fabricated: CocoStorage = { async init() {} };
// @ts-expect-error Former configuration is unsupported.
initializeCoco({ repo: storage, seedGetter });
declare const driver: SqlDatabase;
createSqliteStorage({ database: driver });
new SqlTransactionConflictError('retry', { cause: new Error() });
runSqlDatabaseContract;
`,
      );
      const result = Bun.spawnSync([
        process.execPath,
        join(root, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'esnext',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        join(directory, 'consumer.ts'),
      ]);
      expect(result.stdout.toString() + result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20000);
});
