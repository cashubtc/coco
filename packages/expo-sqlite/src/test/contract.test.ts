import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  createDummyMint,
} from '@cashu/coco-adapter-tests';
import {
  createTransactionalSqliteDurableEventOutboxRepository,
  runSqlDatabaseContract,
} from '@cashu/coco-sql-storage/test';
import { configureDurableEventOutboxStorageLimits, ensureSchema } from '@cashu/coco-sql-storage';
import type { DurableEventStorageLimits } from '@cashu/coco-core/adapter';
import { SqliteRepositories as Repositories } from '../index.ts';
import type { SqliteRepositoriesOptions } from '../index.ts';
import { ExpoSqliteDb } from '../db.ts';

type RunResult = { changes: number; lastInsertRowId: number; lastInsertRowid: number };

class BunExpoSqliteDatabaseShim {
  private readonly db: Database;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
  }

  async execAsync(sql: string): Promise<void> {
    (this.db as unknown as { exec(statement: string): void }).exec(sql);
  }

  async runAsync(sql: string, ...params: any[]): Promise<RunResult> {
    const statement = this.db.prepare(sql);
    const result = statement.run(...params) as unknown as {
      changes?: number;
      lastInsertRowid?: number;
    };
    const changes = Number(result?.changes ?? 0);
    const lastInsertRowId = Number(result?.lastInsertRowid ?? 0);
    return { changes, lastInsertRowId, lastInsertRowid: lastInsertRowId };
  }

  async getFirstAsync<T = unknown>(sql: string, ...params: any[]): Promise<T | null> {
    const statement = this.db.prepare(sql);
    const row = statement.get(...params) as T | undefined;
    return row ?? null;
  }

  async getAllAsync<T = unknown>(sql: string, ...params: any[]): Promise<T[]> {
    const statement = this.db.prepare(sql);
    const rows = statement.all(...params) as T[] | undefined;
    return rows ?? [];
  }

  async closeAsync(): Promise<void> {
    this.db.close();
  }
}

class WebExpoSqliteDatabaseShim extends BunExpoSqliteDatabaseShim {
  exclusiveTransactionCalls = 0;
  transactionCalls = 0;

  async withExclusiveTransactionAsync(): Promise<void> {
    this.exclusiveTransactionCalls++;
    throw new Error('withExclusiveTransactionAsync is not supported on web');
  }

  async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
    this.transactionCalls++;
    await this.execAsync('BEGIN');
    try {
      await fn();
      await this.execAsync('COMMIT');
    } catch (error) {
      await this.execAsync('ROLLBACK');
      throw error;
    }
  }
}

class NativeExpoSqliteDatabaseShim extends BunExpoSqliteDatabaseShim {
  exclusiveTransactionCalls = 0;
  transactionCalls = 0;
  executedSql: string[] = [];

  override async execAsync(sql: string): Promise<void> {
    this.executedSql.push(sql);
    await super.execAsync(sql);
  }

  async withExclusiveTransactionAsync(fn: (txn: BunExpoSqliteDatabaseShim) => Promise<void>) {
    this.exclusiveTransactionCalls++;
    await this.execAsync('BEGIN');
    try {
      await fn(this);
      await this.execAsync('COMMIT');
    } catch (error) {
      await this.execAsync('ROLLBACK');
      throw error;
    }
  }

  async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
    this.transactionCalls++;
    await this.execAsync('BEGIN');
    try {
      await fn();
      await this.execAsync('COMMIT');
    } catch (error) {
      await this.execAsync('ROLLBACK');
      throw error;
    }
  }
}

async function createRepositories() {
  const rawDatabase = new BunExpoSqliteDatabaseShim();
  const repositories = new Repositories({
    database: rawDatabase as unknown as SqliteRepositoriesOptions['database'],
  });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      await rawDatabase.closeAsync();
    },
  } as const;
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
      const rawDatabase = new BunExpoSqliteDatabaseShim();
      const database = new ExpoSqliteDb({
        database: rawDatabase as unknown as SqliteRepositoriesOptions['database'],
      });
      await ensureSchema(database);
      if (options?.limits) {
        await configureDurableEventOutboxStorageLimits(database, options.limits);
      }
      return {
        repository: createTransactionalSqliteDurableEventOutboxRepository(database),
        dispose: () => rawDatabase.closeAsync(),
      };
    },
    async createSharedRepositories() {
      const directory = await mkdtemp(join(tmpdir(), 'coco-expo-sqlite-outbox-'));
      const filename = join(directory, 'wallet.sqlite');
      const firstRawDatabase = new NativeExpoSqliteDatabaseShim(filename);
      const secondRawDatabase = new NativeExpoSqliteDatabaseShim(filename);
      const firstDatabase = new ExpoSqliteDb({
        database: firstRawDatabase as unknown as SqliteRepositoriesOptions['database'],
      });
      const secondDatabase = new ExpoSqliteDb({
        database: secondRawDatabase as unknown as SqliteRepositoriesOptions['database'],
      });
      await ensureSchema(firstDatabase);
      await ensureSchema(secondDatabase);
      await firstRawDatabase.execAsync('PRAGMA busy_timeout = 0');
      await secondRawDatabase.execAsync('PRAGMA busy_timeout = 0');
      return {
        first: createTransactionalSqliteDurableEventOutboxRepository(firstDatabase),
        second: createTransactionalSqliteDurableEventOutboxRepository(secondDatabase),
        dispose: async () => {
          await firstRawDatabase.closeAsync();
          await secondRawDatabase.closeAsync();
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
    async createRestartableRepository() {
      const directory = await mkdtemp(join(tmpdir(), 'coco-expo-sqlite-outbox-restart-'));
      const filename = join(directory, 'wallet.sqlite');
      let rawDatabase = new NativeExpoSqliteDatabaseShim(filename);
      let database = new ExpoSqliteDb({
        database: rawDatabase as unknown as SqliteRepositoriesOptions['database'],
      });
      await ensureSchema(database);
      const reopen = async () => {
        await rawDatabase.closeAsync();
        rawDatabase = new NativeExpoSqliteDatabaseShim(filename);
        database = new ExpoSqliteDb({
          database: rawDatabase as unknown as SqliteRepositoriesOptions['database'],
        });
        await ensureSchema(database);
        return createTransactionalSqliteDurableEventOutboxRepository(database);
      };
      return {
        repository: createTransactionalSqliteDurableEventOutboxRepository(database),
        restart: reopen,
        dispose: async () => {
          await rawDatabase.closeAsync();
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
  },
  { describe, it, expect },
);

runAuthSessionRepositoryContract({ createRepositories }, { describe, it, expect });

runProofRepositoryContract({ createRepositories }, { describe, it, expect });

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
    const repositories = new Repositories({
      database: database as unknown as SqliteRepositoriesOptions['database'],
    });

    try {
      await repositories.init();
      database.exclusiveTransactionCalls = 0;
      database.transactionCalls = 0;

      await repositories.withTransaction(async (tx) => {
        await tx.mintRepository.addOrUpdateMint(createDummyMint());
      });

      expect(database.exclusiveTransactionCalls).toBe(0);
      expect(database.transactionCalls).toBe(1);
      await expect(repositories.mintRepository.getAllMints()).resolves.toHaveLength(1);
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
    const repositories = new Repositories({
      database: database as unknown as SqliteRepositoriesOptions['database'],
    });

    try {
      await repositories.init();
      database.exclusiveTransactionCalls = 0;
      database.transactionCalls = 0;

      await repositories.withTransaction(async (tx) => {
        await tx.mintRepository.addOrUpdateMint(createDummyMint());
      });

      expect(database.exclusiveTransactionCalls).toBe(1);
      expect(database.transactionCalls).toBe(0);
      await expect(repositories.mintRepository.getAllMints()).resolves.toHaveLength(1);
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
