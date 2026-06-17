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

runAuthSessionRepositoryContract({ createRepositories }, { describe, it, expect });

runProofRepositoryContract({ createRepositories }, { describe, it, expect });

runMintOperationRepositoryContract({ createRepositories }, { describe, it, expect });

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
});

function restoreGlobalProperty(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, name);
}
