import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  runRepositoryTransactionContract,
  runAuthSessionRepositoryContract,
  runProofRepositoryContract,
  runMintOperationRepositoryContract,
  runReceiveOperationRepositoryContract,
  runSendOperationRepositoryContract,
  runMeltOperationRepositoryContract,
  createDummyMint,
  createDummyKeyset,
  createDummyProof,
} from '@cashu/coco-adapter-tests';
import { ExpoSqliteRepositories as Repositories } from '../index.ts';
import type { ExpoSqliteRepositoriesOptions } from '../index.ts';

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
  const database = new BunExpoSqliteDatabaseShim();
  const repositories = new Repositories({
    database: database as unknown as ExpoSqliteRepositoriesOptions['database'],
  });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      await repositories.db.raw.closeAsync?.();
    },
  } as const;
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
      database: database as unknown as ExpoSqliteRepositoriesOptions['database'],
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
      await repositories.db.raw.closeAsync?.();
      restoreGlobalProperty('window', windowDescriptor);
      restoreGlobalProperty('document', documentDescriptor);
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
