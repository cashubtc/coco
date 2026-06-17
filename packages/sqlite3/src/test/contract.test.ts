import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
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
import { SqliteDb } from '../db.ts';

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
  const rawDatabase = new Database(':memory:');
  const database = new SqliteDb({ database: rawDatabase });
  const repositories = new Repositories({ database: rawDatabase });
  await repositories.init();
  return {
    repositories,
    database,
    dispose: async () => {
      await database.close();
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
  database: SqliteDb,
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
  database: SqliteDb,
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

describe('sqlite3 quote storage constraints', () => {
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

describe('sqlite3 adapter transactions', () => {
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
