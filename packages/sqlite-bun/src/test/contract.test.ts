import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  runRepositoryTransactionContract,
  runKeyRingDerivationRepositoryContract,
  runAuthSessionRepositoryContract,
  runProofRepositoryContract,
  runMintOperationRepositoryContract,
  runMintQuoteRepositoryContract,
  runPaymentRequestReceiveRepositoryContract,
  runReceiveOperationRepositoryContract,
  runSendOperationRepositoryContract,
  runMeltOperationRepositoryContract,
  runMeltQuoteRepositoryContract,
  runDurableEventOutboxRepositoryContract,
  runDurableEventOutboxHostContract,
  createDurableEventOutboxRepositoryFromTransactionPort,
} from '@cashu/coco-adapter-tests';
import { runSqlDatabaseContract } from '@cashu/coco-sql-storage/test';
import type { DurableEventStorageLimits } from '@cashu/coco-core/adapter';
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

async function createSharedRepositories() {
  const directory = await mkdtemp(join(tmpdir(), 'coco-sqlite-bun-keyring-'));
  const filename = join(directory, 'wallet.sqlite');
  const firstDatabase = new Database(filename);
  const secondDatabase = new Database(filename);
  const first = new Repositories({ database: firstDatabase });
  const second = new Repositories({ database: secondDatabase });
  await first.init();
  await second.init();
  firstDatabase.exec('PRAGMA busy_timeout = 10');
  secondDatabase.exec('PRAGMA busy_timeout = 10');

  return {
    first,
    second,
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
    testConcurrentRootOperationIsolation: true,
  },
  { describe, it, expect },
);

runKeyRingDerivationRepositoryContract(
  { createRepositories, createSharedRepositories },
  { describe, it, expect },
);

runDurableEventOutboxRepositoryContract(
  {
    async createRepository(options?: { readonly limits?: DurableEventStorageLimits }) {
      const rawDatabase = new Database(':memory:');
      const repositories = new Repositories({ database: rawDatabase });
      await repositories.init();
      if (options?.limits) {
        await repositories.configureDurableEventOutboxStorageLimits(options.limits);
      }
      return {
        repository: createDurableEventOutboxRepositoryFromTransactionPort(
          repositories.durableEventOutbox,
        ),
        dispose: async () => rawDatabase.close(),
      };
    },
    async createSharedRepositories() {
      const directory = await mkdtemp(join(tmpdir(), 'coco-sqlite-bun-outbox-'));
      const filename = join(directory, 'wallet.sqlite');
      const firstRawDatabase = new Database(filename);
      const secondRawDatabase = new Database(filename);
      const firstRepositories = new Repositories({ database: firstRawDatabase });
      const secondRepositories = new Repositories({ database: secondRawDatabase });
      await firstRepositories.init();
      await secondRepositories.init();
      firstRawDatabase.exec('PRAGMA busy_timeout = 0');
      secondRawDatabase.exec('PRAGMA busy_timeout = 0');
      return {
        first: createDurableEventOutboxRepositoryFromTransactionPort(
          firstRepositories.durableEventOutbox,
        ),
        second: createDurableEventOutboxRepositoryFromTransactionPort(
          secondRepositories.durableEventOutbox,
        ),
        dispose: async () => {
          firstRawDatabase.close();
          secondRawDatabase.close();
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
    async createRestartableRepository() {
      const directory = await mkdtemp(join(tmpdir(), 'coco-sqlite-bun-outbox-restart-'));
      const filename = join(directory, 'wallet.sqlite');
      let rawDatabase = new Database(filename);
      let repositories = new Repositories({ database: rawDatabase });
      await repositories.init();
      const reopen = async () => {
        rawDatabase.close();
        rawDatabase = new Database(filename);
        repositories = new Repositories({ database: rawDatabase });
        await repositories.init();
        return createDurableEventOutboxRepositoryFromTransactionPort(
          repositories.durableEventOutbox,
        );
      };
      return {
        repository: createDurableEventOutboxRepositoryFromTransactionPort(
          repositories.durableEventOutbox,
        ),
        restart: reopen,
        dispose: async () => {
          rawDatabase.close();
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
  },
  { describe, it, expect },
);

runDurableEventOutboxHostContract({ createRepositories }, { describe, it, expect });

function runAllocationWorker(filename: string, count: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./keyringAllocation.worker.ts', import.meta.url), {
      workerData: { filename, count },
    });
    worker.once('message', (message: { indexes?: number[]; error?: string }) => {
      if (message.error) reject(new Error(message.error));
      else resolve(message.indexes ?? []);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Allocation worker exited with code ${code}`));
    });
  });
}

describe('keyring allocation process boundary', () => {
  it('coordinates worker connections through the SQLite file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coco-sqlite-bun-worker-'));
    const filename = join(directory, 'wallet.sqlite');
    const database = new Database(filename);
    const repositories = new Repositories({ database });
    await repositories.init();
    database.close();

    try {
      const [first, second] = await Promise.all([
        runAllocationWorker(filename, 50),
        runAllocationWorker(filename, 50),
      ]);
      const indexes = [...first, ...second].sort((left, right) => left - right);
      expect(indexes).toEqual(Array.from({ length: 100 }, (_, index) => index));
      expect(new Set(indexes).size).toBe(100);

      const reopenedDatabase = new Database(filename);
      const reopened = new Repositories({ database: reopenedDatabase });
      await reopened.init();
      try {
        await expect(
          reopened.keyRingRepository.deriveAndPersistKeyPair(
            'nut20_mint_quote',
            (derivationIndex) => ({
              publicKeyHex: '03' + derivationIndex.toString(16).padStart(64, '0'),
              secretKey: new Uint8Array(32).fill((derivationIndex % 254) + 1),
              derivationIndex,
              purpose: 'nut20_mint_quote',
            }),
          ),
        ).resolves.toMatchObject({ derivationIndex: 100 });
      } finally {
        reopenedDatabase.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
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
