import { describe, expect, it } from 'bun:test';
import { runRepositoryTransactionContract } from '@cashu/coco-adapter-tests';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

async function createRepositories() {
  return {
    repositories: new MemoryRepositories(),
    dispose: async () => {},
  };
}

async function createSharedRepositories() {
  const repositories = new MemoryRepositories();
  return {
    first: repositories,
    second: repositories,
    dispose: async () => {},
  };
}

runRepositoryTransactionContract(
  {
    createRepositories,
    createSharedRepositories,
    testConcurrentRootOperationIsolation: true,
    testWriterOwnershipAtEntry: true,
  },
  { describe, it, expect },
);

describe('MemoryRepositories transaction byte isolation', () => {
  it('rolls back mutations to Buffer-backed key material', async () => {
    const repositories = new MemoryRepositories();
    const publicKeyHex = `02${'01'.repeat(32)}`;
    await repositories.keyRingRepository.setPersistedKeyPair({
      publicKeyHex,
      secretKey: Buffer.from([1, 2, 3]),
      purpose: 'p2pk',
    });

    await expect(
      repositories.withTransaction(async ({ keyRingRepository }) => {
        const keyPair = await keyRingRepository.getPersistedKeyPair(publicKeyHex, 'p2pk');
        expect(keyPair).not.toBeNull();
        keyPair!.secretKey[0] = 9;
        throw new Error('abort Wallet transaction');
      }),
    ).rejects.toThrow('abort Wallet transaction');

    const stored = await repositories.keyRingRepository.getPersistedKeyPair(publicKeyHex, 'p2pk');
    expect(Array.from(stored!.secretKey)).toEqual([1, 2, 3]);
  });
});
