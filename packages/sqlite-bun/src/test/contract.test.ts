import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  runRepositoryTransactionContract,
  createDummyMint,
  createDummyKeyset,
  createDummyProof,
} from 'coco-cashu-adapter-tests';
import { getStorageRepositories, withStorageTransaction } from 'coco-cashu-core/adapter';
import { SqliteStorage } from '../index.ts';

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
  const database = new Database(':memory:');
  const repositories = new SqliteStorage({ database });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      repositories.db.close();
    },
  };
}

runRepositoryTransactionContract(
  {
    createRepositories,
  },
  { describe, it, expect },
);

describe('sqlite-bun adapter transactions', () => {
  it('commits across repositories', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      const repoSet = getStorageRepositories(repositories);
      await withStorageTransaction(repositories, async (tx) => {
        await tx.mintRepository.addOrUpdateMint(createDummyMint());
        await tx.keysetRepository.addKeyset(createDummyKeyset());
        await tx.proofRepository.saveProofs('https://mint.test', [createDummyProof()]);
      });

      const mints = await repoSet.mintRepository.getAllMints();
      expect(mints.length).toBe(1);
      const proofs = await repoSet.proofRepository.getAllReadyProofs();
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
        await withStorageTransaction(repositories, async (tx) => {
          await tx.mintRepository.addOrUpdateMint(createDummyMint());
          await tx.proofRepository.saveProofs('https://mint.test', [createDummyProof()]);
          throw new Error('boom');
        });
      } catch {
        didThrow = true;
      }
      expect(didThrow).toBe(true);

      const repoSet = getStorageRepositories(repositories);
      const mints = await repoSet.mintRepository.getAllMints();
      expect(mints.length).toBe(0);
      const proofs = await repoSet.proofRepository.getAllReadyProofs();
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

      const firstPromise = withStorageTransaction(repositories, async (tx) => {
        await tx.mintRepository.addOrUpdateMint(mintA);
        firstEntered.resolve();
        await releaseFirst.promise;
      });

      await firstEntered.promise;

      const secondPromise = withStorageTransaction(repositories, async (tx) => {
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

      const mints = await getStorageRepositories(repositories).mintRepository.getAllMints();
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
