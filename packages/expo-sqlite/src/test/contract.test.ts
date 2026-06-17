import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  runRepositoryTransactionContract,
  runAuthSessionRepositoryContract,
  runProofRepositoryContract,
  runMintOperationRepositoryContract,
  runPaymentRequestReceiveRepositoryContract,
  runReceiveOperationRepositoryContract,
  runSendOperationRepositoryContract,
  runMeltOperationRepositoryContract,
  runMeltQuoteRepositoryContract,
  createDummyMint,
  createDummyKeyset,
  createDummyProof,
} from '@cashu/coco-adapter-tests';
import { runSqlDatabaseContract } from '@cashu/coco-sql-storage/test';
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
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statementSql of statements) {
      const statement = this.db.prepare(statementSql);
      statement.run();
    }
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

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject } as const;
}

async function createRepositories() {
  const rawDatabase = new BunExpoSqliteDatabaseShim();
  const database = new ExpoSqliteDb({
    database: rawDatabase as unknown as SqliteRepositoriesOptions['database'],
  });
  const repositories = new Repositories({
    database: rawDatabase as unknown as SqliteRepositoriesOptions['database'],
  });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      await rawDatabase.closeAsync();
    },
    database,
  } as const;
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

async function expectRejects(fn: () => Promise<void>) {
  let didThrow = false;
  try {
    await fn();
  } catch {
    didThrow = true;
  }
  expect(didThrow).toBe(true);
}

async function insertMintQuoteRow(
  database: ExpoSqliteDb,
  method: string,
  quoteId: string,
): Promise<void> {
  await database.run(
    `INSERT INTO coco_cashu_canonical_mint_quotes
       (mintUrl, method, quoteId, state, request, amount, unit, quoteDataJson, reusable, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'https://mint.test',
      method,
      quoteId,
      method === 'bolt11' ? 'UNPAID' : null,
      `${method}-request`,
      method === 'bolt11' ? '1' : null,
      'sat',
      method === 'bolt11'
        ? '{"amount":"1"}'
        : '{"pubkey":"02","amountPaid":"0","amountIssued":"0"}',
      method === 'bolt11' ? 0 : 1,
      0,
      0,
    ],
  );
}

async function insertMeltQuoteRow(
  database: ExpoSqliteDb,
  method: string,
  quoteId: string,
): Promise<void> {
  await database.run(
    `INSERT INTO coco_cashu_melt_quotes
       (mintUrl, method, quoteId, state, request, amount, unit, expiry, fee_reserve, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['https://mint.test', method, quoteId, 'UNPAID', `${method}-request`, '1', 'sat', 0, '1', 0, 0],
  );
}

runRepositoryTransactionContract(
  {
    createRepositories,
    testConcurrentRootOperationIsolation: true,
  },
  { describe, it, expect },
);

runAuthSessionRepositoryContract({ createRepositories }, { describe, it, expect });

runProofRepositoryContract({ createRepositories }, { describe, it, expect });

runMintOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runReceiveOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runSendOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltQuoteRepositoryContract({ createRepositories }, { describe, it, expect });

runPaymentRequestReceiveRepositoryContract({ createRepositories }, { describe, it, expect });

describe('expo-sqlite quote storage constraints', () => {
  it('rejects persisted mint quote method siblings for one identity', async () => {
    const { database, dispose } = await createRepositories();
    try {
      await insertMintQuoteRow(database, 'bolt11', 'duplicate-mint-quote');
      await expectRejects(() => insertMintQuoteRow(database, 'bolt12', 'duplicate-mint-quote'));
    } finally {
      await dispose();
    }
  });

  it('rejects persisted melt quote method siblings for one identity', async () => {
    const { database, dispose } = await createRepositories();
    try {
      await insertMeltQuoteRow(database, 'bolt11', 'duplicate-melt-quote');
      await expectRejects(() => insertMeltQuoteRow(database, 'bolt12', 'duplicate-melt-quote'));
    } finally {
      await dispose();
    }
  });
});

describe('expo-sqlite adapter transactions', () => {
  it('commits across repositories', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await repositories.withTransaction(async (tx) => {
        await tx.mintRepository.addOrUpdateMint(createDummyMint());
        await tx.keysetRepository.addKeyset(createDummyKeyset());
        await tx.proofRepository.saveProofs('https://mint.test', [createDummyProof()]);
      });

      const mints = await repositories.mintRepository.getAllMints();
      expect(mints.length).toBe(1);
      const proofs = await repositories.proofRepository.getAllReadyProofs();
      expect(proofs.length).toBe(1);
    } finally {
      await dispose();
    }
  });

  it('rolls back when an error is thrown', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      let didThrow = false;
      try {
        await repositories.withTransaction(async (tx) => {
          await tx.mintRepository.addOrUpdateMint(createDummyMint());
          await tx.proofRepository.saveProofs('https://mint.test', [createDummyProof()]);
          throw new Error('boom');
        });
      } catch {
        didThrow = true;
      }
      expect(didThrow).toBe(true);

      const mints = await repositories.mintRepository.getAllMints();
      expect(mints.length).toBe(0);
      const proofs = await repositories.proofRepository.getAllReadyProofs();
      expect(proofs.length).toBe(0);
    } finally {
      await dispose();
    }
  });

  it('queues concurrent transactions instead of sharing the same scope', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      const firstEntered = createDeferred();
      const releaseFirst = createDeferred();
      const secondStarted = createDeferred();

      const mintA = { ...createDummyMint(), mintUrl: 'https://mint-a.test' };
      const mintB = { ...createDummyMint(), mintUrl: 'https://mint-b.test' };

      const firstPromise = repositories.withTransaction(async (tx) => {
        await tx.mintRepository.addOrUpdateMint(mintA);
        firstEntered.resolve();
        await releaseFirst.promise;
      });

      await firstEntered.promise;

      const secondPromise = repositories.withTransaction(async (tx) => {
        secondStarted.resolve();
        await tx.mintRepository.addOrUpdateMint(mintB);
      });

      let secondResolved = false;
      await Promise.race([
        secondStarted.promise.then(() => {
          secondResolved = true;
        }),
        new Promise((resolve) => setTimeout(resolve, 25)),
      ]);
      expect(secondResolved).toBe(false);

      releaseFirst.resolve();

      await Promise.all([firstPromise, secondPromise]);

      const mints = await repositories.mintRepository.getAllMints();
      expect(mints).toHaveLength(2);
      expect(mints.map((m) => m.mintUrl).sort()).toEqual([
        'https://mint-a.test',
        'https://mint-b.test',
      ]);
    } finally {
      await dispose();
    }
  });
});

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
});

function restoreGlobalProperty(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, name);
}
