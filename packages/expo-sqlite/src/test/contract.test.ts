import { describe, it, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runRepositoryTransactionContract,
  runKeypairAllocationContract,
  runAuthSessionRepositoryContract,
  runKeysetRepositoryContract,
  runProofRepositoryContract,
  runMintOperationRepositoryContract,
  runMintQuoteRepositoryContract,
  runPaymentRequestReceiveRepositoryContract,
  runReceiveOperationRepositoryContract,
  runSendOperationRepositoryContract,
  runMeltOperationRepositoryContract,
  runMeltQuoteRepositoryContract,
  runMintSwapPersistenceContract,
} from '@cashu/coco-adapter-tests';
import { runSqlDatabaseContract } from '@cashu/coco-sql-storage/test';
import { SqliteRepositories as Repositories } from '../index.ts';
import type { SqliteRepositoriesOptions } from '../index.ts';
import { ExpoSqliteDb } from '../db.ts';

import {
  BunExpoSqliteDatabaseShim,
  WebExpoSqliteDatabaseShim,
  NativeExpoSqliteDatabaseShim,
} from './databaseShim.ts';

async function createRepositories() {
  const rawDatabase = new BunExpoSqliteDatabaseShim();
  const repositories = new Repositories({
    database: rawDatabase as unknown as SqliteRepositoriesOptions['database'],
  });
  await repositories.init();
  return {
    repositories,
    rawDatabase,
    dispose: async () => {
      await rawDatabase.closeAsync();
    },
  } as const;
}

async function createMintSwapRepositories() {
  const rawDatabase = new BunExpoSqliteDatabaseShim();
  const repositories = new Repositories({
    database: rawDatabase as unknown as SqliteRepositoriesOptions['database'],
    mintSwap: true,
  });
  await repositories.init();
  return {
    repositories,
    dispose: async () => rawDatabase.closeAsync(),
  };
}

async function createSharedRepositories() {
  const directory = await mkdtemp(join(tmpdir(), 'coco-expo-sqlite-keyring-'));
  const filename = join(directory, 'wallet.sqlite');
  const firstDatabase = new NativeExpoSqliteDatabaseShim(filename);
  const secondDatabase = new NativeExpoSqliteDatabaseShim(filename);
  const first = new Repositories({
    database: firstDatabase as unknown as SqliteRepositoriesOptions['database'],
  });
  const second = new Repositories({
    database: secondDatabase as unknown as SqliteRepositoriesOptions['database'],
  });
  await first.init();
  await second.init();
  await firstDatabase.execAsync('PRAGMA busy_timeout = 10');
  await secondDatabase.execAsync('PRAGMA busy_timeout = 10');

  return {
    first,
    second,
    dispose: async () => {
      await firstDatabase.closeAsync();
      await secondDatabase.closeAsync();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

runSqlDatabaseContract(
  {
    createDatabase() {
      const rawDatabase = new BunExpoSqliteDatabaseShim();
      const database = new ExpoSqliteDb({
        database: rawDatabase as unknown as SqliteRepositoriesOptions['database'],
      });

      return {
        database,
        dispose: async () => {
          await database.raw.closeAsync?.();
        },
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

runMintSwapPersistenceContract(
  {
    createRepositories: createMintSwapRepositories,
    createDisabledRepositories: createRepositories,
  },
  { describe, it, expect },
);

runAuthSessionRepositoryContract({ createRepositories }, { describe, it, expect });

runProofRepositoryContract({ createRepositories }, { describe, it, expect });
runKeysetRepositoryContract(
  { createRepositories, createSharedRepositories },
  { describe, it, expect },
);

runMintOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMintQuoteRepositoryContract({ createRepositories }, { describe, it, expect });

runReceiveOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runSendOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltQuoteRepositoryContract({ createRepositories }, { describe, it, expect });

runPaymentRequestReceiveRepositoryContract({ createRepositories }, { describe, it, expect });

describe('expo-sqlite web transaction compatibility', () => {
  it('uses withTransactionAsync when exclusive transactions are unavailable on web', async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: {}, configurable: true });

    const database = new WebExpoSqliteDatabaseShim();
    const wrappedDatabase = new ExpoSqliteDb({
      database: database as unknown as SqliteRepositoriesOptions['database'],
    });

    try {
      database.exclusiveTransactionCalls = 0;
      database.transactionCalls = 0;

      await wrappedDatabase.transaction(async (transaction) => {
        await expect(transaction.get<{ value: number }>('SELECT 1 AS value')).resolves.toEqual({
          value: 1,
        });
      });

      expect(database.exclusiveTransactionCalls).toBe(0);
      expect(database.transactionCalls).toBe(1);
    } finally {
      await database.closeAsync();
      restoreGlobalProperty('window', windowDescriptor);
      restoreGlobalProperty('document', documentDescriptor);
    }
  });
});

describe('expo-sqlite native transaction compatibility', () => {
  it('uses exclusive transactions when available outside web', async () => {
    const database = new NativeExpoSqliteDatabaseShim();
    const wrappedDatabase = new ExpoSqliteDb({
      database: database as unknown as SqliteRepositoriesOptions['database'],
    });

    try {
      database.exclusiveTransactionCalls = 0;
      database.transactionCalls = 0;

      await wrappedDatabase.transaction(async (transaction) => {
        await expect(transaction.get<{ value: number }>('SELECT 1 AS value')).resolves.toEqual({
          value: 1,
        });
      });

      expect(database.exclusiveTransactionCalls).toBe(1);
      expect(database.transactionCalls).toBe(0);
    } finally {
      await database.closeAsync();
    }
  });

  it('uses BEGIN IMMEDIATE before reading when immediate mode is requested', async () => {
    const database = new NativeExpoSqliteDatabaseShim();
    const wrappedDatabase = new ExpoSqliteDb({
      database: database as unknown as SqliteRepositoriesOptions['database'],
    });

    try {
      await wrappedDatabase.transaction(
        async (transaction) => {
          await expect(transaction.get<{ value: number }>('SELECT 1 AS value')).resolves.toEqual({
            value: 1,
          });
        },
        { mode: 'immediate' },
      );

      expect(database.executedSql).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
      expect(database.exclusiveTransactionCalls).toBe(0);
      expect(database.transactionCalls).toBe(0);
    } finally {
      await database.closeAsync();
    }
  });
});

function restoreGlobalProperty(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, name);
}

describe('hydration corruption guard', () => {
  it('throws when send operation has prepared state but null financial fields', async () => {
    const { repositories, rawDatabase, dispose } = await createRepositories();
    try {
      await rawDatabase.runAsync(
        `INSERT INTO coco_cashu_send_operations
           (id, mintUrl, amount, unit, state, createdAt, updatedAt, method, methodDataJson, needsSwap, fee, inputAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...[
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
    const { repositories, rawDatabase, dispose } = await createRepositories();
    try {
      await rawDatabase.runAsync(
        `INSERT INTO coco_cashu_receive_operations
           (id, mintUrl, amount, unit, state, createdAt, updatedAt, fee, inputProofsJson)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...['corrupt-receive', 'https://mint.test', '100', 'sat', 'prepared', 0, 0, null, '[]'],
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
    const { repositories, rawDatabase, dispose } = await createRepositories();
    try {
      await rawDatabase.runAsync(
        `INSERT INTO coco_cashu_melt_operations
           (id, mintUrl, state, createdAt, updatedAt, method, methodDataJson, quoteId, amount, fee_reserve, swap_fee, needsSwap, inputAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...[
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
