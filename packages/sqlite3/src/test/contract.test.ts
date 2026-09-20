import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runRepositoryTransactionContract,
  runKeypairAllocationContract,
  allocateKeypairForTest,
  runAuthSessionRepositoryContract,
  runProofRepositoryContract,
  runMintOperationRepositoryContract,
  runMintQuoteRepositoryContract,
  runPaymentRequestReceiveRepositoryContract,
  runReceiveOperationRepositoryContract,
  runSendOperationRepositoryContract,
  runMeltOperationRepositoryContract,
  runMeltQuoteRepositoryContract,
} from '@cashu/coco-adapter-tests';
import { RepositoryTransactionConflictError } from '@cashu/coco-core/adapter';
import { runSqlDatabaseContract } from '@cashu/coco-sql-storage/test';
import { SqliteRepositories as Repositories } from '../index.ts';
import { SqliteDb } from '../db.ts';

async function createRepositories() {
  const rawDatabase = new Database(':memory:');
  const repositories = new Repositories({ database: rawDatabase });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      rawDatabase.close();
    },
  };
}

async function createSharedRepositories(useAlias = false) {
  const directory = await mkdtemp(join(tmpdir(), 'coco-sqlite3-keyring-'));
  const filename = join(directory, 'wallet.sqlite');
  const firstDatabase = new Database(filename);
  const secondFilename = useAlias ? join(directory, 'wallet-alias.sqlite') : filename;
  if (useAlias) await symlink(filename, secondFilename);
  const secondDatabase = new Database(secondFilename);
  const first = new Repositories({ database: firstDatabase });
  const second = new Repositories({ database: secondDatabase });
  await first.init();
  await second.init();

  return {
    first,
    second,
    firstDatabase,
    secondDatabase,
    dispose: async () => {
      firstDatabase.close();
      secondDatabase.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

runSqlDatabaseContract(
  {
    createDatabase() {
      const rawDatabase = new Database(':memory:');
      const database = new SqliteDb({ database: rawDatabase });

      return {
        database,
        dispose: () => database.close(),
      };
    },
  },
  { describe, it, expect },
);

runRepositoryTransactionContract(
  {
    createRepositories,
    createSharedRepositories,
    testConcurrentRootOperationIsolation: true,
    testWriterOwnershipAtEntry: true,
  },
  { describe, it, expect },
);

runKeypairAllocationContract(
  { createRepositories, createSharedRepositories },
  { describe, it, expect },
);

describe('synchronous SQLite contention', () => {
  for (const useAlias of [false, true]) {
    it(`allocates across default connections (file alias: ${useAlias})`, async () => {
      const { first, second, dispose } = await createSharedRepositories(useAlias);
      try {
        const started = performance.now();
        const keys = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            allocateKeypairForTest(index % 2 === 0 ? first : second, 'p2pk'),
          ),
        );
        expect(performance.now() - started).toBeLessThan(2000);
        expect(keys.map((key) => key.derivationIndex ?? -1).sort((a, b) => a - b)).toEqual(
          Array.from({ length: 20 }, (_, index) => index),
        );
        expect(new Set(keys.map((key) => key.publicKeyHex)).size).toBe(20);
        expect(await second.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(19);
      } finally {
        await dispose();
      }
    });
  }

  it('preserves native waiting for unrelated in-memory databases', async () => {
    const firstDatabase = new Database(':memory:');
    const secondDatabase = new Database(':memory:');
    const first = new SqliteDb({ database: firstDatabase });
    const second = new SqliteDb({ database: secondDatabase });
    firstDatabase.exec('PRAGMA busy_timeout = 5000');
    secondDatabase.exec('PRAGMA busy_timeout = 2345');
    try {
      await first.transaction(
        async () => {
          await second.transaction(
            async () => {
              expect(secondDatabase.prepare('PRAGMA busy_timeout').get()).toEqual({
                timeout: 2345,
              });
            },
            { mode: 'immediate' },
          );
        },
        { mode: 'immediate' },
      );
      await second.transaction(
        async () => {
          expect(secondDatabase.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 2345 });
        },
        { mode: 'immediate' },
      );
      expect(secondDatabase.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 2345 });
    } finally {
      firstDatabase.close();
      secondDatabase.close();
    }
  });

  for (const useAlias of [false, true]) {
    it(`returns prompt conflicts and restores settings (file alias: ${useAlias})`, async () => {
      const { first, second, firstDatabase, secondDatabase, dispose } =
        await createSharedRepositories(useAlias);
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const owner = first.withTransaction(async (scope) => {
        await scope.keyRingRepository.setLastAllocatedIndex('p2pk', 7);
        entered();
        await held;
      });
      try {
        await Promise.race([ready, owner]);
        let contenderEntered = false;
        const started = performance.now();
        await expect(
          second.withTransaction(async () => {
            contenderEntered = true;
          }),
        ).rejects.toBeInstanceOf(RepositoryTransactionConflictError);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(contenderEntered).toBe(false);
        await expect(allocateKeypairForTest(second, 'p2pk')).rejects.toBeInstanceOf(
          RepositoryTransactionConflictError,
        );
        expect(performance.now() - started).toBeLessThan(1000);
        expect(secondDatabase.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
        // A failed BEGIN must neither roll back the owner nor expose its uncommitted write.
        expect(await second.keyRingRepository.getLastAllocatedIndex('p2pk')).toBeNull();
        release();
        await owner;
        expect(firstDatabase.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
        expect(await second.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(7);

        const failure = new Error('rollback this allocation');
        await expect(
          second.withTransaction(async (scope) => {
            // Completed and failed attempts must remove their local contention hints.
            expect(secondDatabase.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
            await scope.keyRingRepository.setLastAllocatedIndex('p2pk', 8);
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect(secondDatabase.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
        expect(await second.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(7);
      } finally {
        release();
        try {
          await owner;
        } finally {
          await dispose();
        }
      }
    });
  }
});

runAuthSessionRepositoryContract({ createRepositories }, { describe, it, expect });

runProofRepositoryContract({ createRepositories }, { describe, it, expect });

runMintOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMintQuoteRepositoryContract({ createRepositories }, { describe, it, expect });

runReceiveOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runSendOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltQuoteRepositoryContract({ createRepositories }, { describe, it, expect });

runPaymentRequestReceiveRepositoryContract({ createRepositories }, { describe, it, expect });

describe('hydration corruption guard', () => {
  it('throws when send operation has prepared state but null financial fields', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await (repositories as any).db.run(
        `INSERT INTO coco_cashu_send_operations
           (id, mintUrl, amount, unit, state, createdAt, updatedAt, method, methodDataJson, needsSwap, fee, inputAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'corrupt-send',
          'https://mint.test',
          '100',
          'sat',
          'prepared',
          0,
          0,
          'default',
          '{}',
          0,
          null,
          null,
        ],
      );

      let threw = false;
      try {
        await repositories.sendOperationRepository.getById('corrupt-send');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('throws when receive operation has prepared state but null fee', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await (repositories as any).db.run(
        `INSERT INTO coco_cashu_receive_operations
           (id, mintUrl, amount, unit, state, createdAt, updatedAt, fee, inputProofsJson)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['corrupt-receive', 'https://mint.test', '100', 'sat', 'prepared', 0, 0, null, '[]'],
      );

      let threw = false;
      try {
        await repositories.receiveOperationRepository.getById('corrupt-receive');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('throws when melt operation has prepared state but null financial fields', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await (repositories as any).db.run(
        `INSERT INTO coco_cashu_melt_operations
           (id, mintUrl, state, createdAt, updatedAt, method, methodDataJson, quoteId, amount, fee_reserve, swap_fee, needsSwap, inputAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'corrupt-melt',
          'https://mint.test',
          'prepared',
          0,
          0,
          'bolt11',
          '{"invoice":"lnbc1test"}',
          'q1',
          null,
          null,
          null,
          0,
          null,
        ],
      );

      let threw = false;
      try {
        await repositories.meltOperationRepository.getById('corrupt-melt');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });
});
