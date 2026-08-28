import { describe, expect, it } from 'bun:test';
import type { Mint } from '../../models/Mint';
import { MemoryRepositories } from '../../repositories/memory';

function createMint(mintUrl: string, trusted = true): Mint {
  return {
    mintUrl,
    name: 'Test Mint',
    mintInfo: {
      name: 'Test Mint',
      pubkey: 'pubkey',
      version: '1.0',
      contact: {},
      nuts: {},
    } as Mint['mintInfo'],
    trusted,
    createdAt: 0,
    updatedAt: 0,
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve } as const;
}

describe('MemoryRepositories transactions', () => {
  it('commits staged creates, updates, and deletes across repositories', async () => {
    const repositories = new MemoryRepositories();
    const mintRepository = repositories.mintRepository;
    const authSessionRepository = repositories.authSessionRepository;
    const updatedMint = createMint('https://updated-mint.test', false);
    const createdMint = createMint('https://created-mint.test');
    const deletedSession = {
      mintUrl: 'https://session-mint.test',
      accessToken: 'access-token',
      expiresAt: 1_730_000_000,
    };

    await mintRepository.addOrUpdateMint(updatedMint);
    await authSessionRepository.saveSession(deletedSession);

    const result = await repositories.withTransaction(async (transaction) => {
      await transaction.mintRepository.addOrUpdateMint(createdMint);
      await transaction.mintRepository.setMintTrusted(updatedMint.mintUrl, true);
      await transaction.authSessionRepository.deleteSession(deletedSession.mintUrl);
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(repositories.mintRepository).toBe(mintRepository);
    expect(repositories.authSessionRepository).toBe(authSessionRepository);
    expect(await mintRepository.getAllMints()).toHaveLength(2);
    expect((await mintRepository.getMintByUrl(updatedMint.mintUrl)).trusted).toBe(true);
    expect(await mintRepository.getMintByUrl(createdMint.mintUrl)).toEqual(createdMint);
    expect(await authSessionRepository.getSession(deletedSession.mintUrl)).toBeNull();
  });

  it('rolls back staged creates, updates, and deletes across repositories', async () => {
    const repositories = new MemoryRepositories();
    const mintRepository = repositories.mintRepository;
    const authSessionRepository = repositories.authSessionRepository;
    const updatedMint = createMint('https://updated-mint.test', false);
    const deletedSession = {
      mintUrl: 'https://session-mint.test',
      accessToken: 'access-token',
      expiresAt: 1_730_000_000,
    };

    await mintRepository.addOrUpdateMint(updatedMint);
    await authSessionRepository.saveSession(deletedSession);

    await expect(
      repositories.withTransaction(async (transaction) => {
        await transaction.mintRepository.addOrUpdateMint(createMint('https://created-mint.test'));
        await transaction.mintRepository.setMintTrusted(updatedMint.mintUrl, true);
        await transaction.authSessionRepository.deleteSession(deletedSession.mintUrl);
        throw new Error('rollback transaction');
      }),
    ).rejects.toThrow('rollback transaction');

    expect(repositories.mintRepository).toBe(mintRepository);
    expect(repositories.authSessionRepository).toBe(authSessionRepository);
    expect(await mintRepository.getAllMints()).toHaveLength(1);
    expect((await mintRepository.getMintByUrl(updatedMint.mintUrl)).trusted).toBe(false);
    expect(await authSessionRepository.getSession(deletedSession.mintUrl)).toEqual(deletedSession);
  });

  it('does not include concurrent root writes in a transaction rollback', async () => {
    const repositories = new MemoryRepositories();
    const transactionEntered = createDeferred();
    const releaseTransaction = createDeferred();
    const transactionMint = createMint('https://transaction-mint.test');
    const outsideMint = createMint('https://outside-mint.test');

    const transactionResult = repositories
      .withTransaction(async (transaction) => {
        await transaction.mintRepository.addOrUpdateMint(transactionMint);
        transactionEntered.resolve();
        await releaseTransaction.promise;
        throw new Error('rollback transaction');
      })
      .catch((error: unknown) => error);

    await transactionEntered.promise;

    let outsideWriteResolved = false;
    const outsideWrite = repositories.mintRepository.addOrUpdateMint(outsideMint).then(() => {
      outsideWriteResolved = true;
    });
    await Promise.resolve();

    expect(outsideWriteResolved).toBe(false);

    releaseTransaction.resolve();
    expect(await transactionResult).toBeInstanceOf(Error);
    await outsideWrite;

    expect(await repositories.mintRepository.getAllMints()).toEqual([outsideMint]);
  });
});
