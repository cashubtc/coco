import { describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import {
  runKeysetRepositoryContract,
  runRepositoryTransactionContract,
} from '@cashu/coco-adapter-tests';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type { CoreProof } from '../../types.ts';

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

runKeysetRepositoryContract({ createRepositories }, { describe, it, expect });

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

describe('MemoryRepositories stored amounts', () => {
  const mintUrl = 'https://mint.test';

  const makeProof = (secret: string, amount: number): CoreProof => ({
    id: 'keyset-1',
    unit: 'sat',
    amount: Amount.from(amount),
    secret,
    C: `C_${secret}`,
    mintUrl,
    state: 'ready',
  });

  // cashu-ts accepts only Amount instances it constructed itself, so a stored Amount must come back
  // as one that Amount.from and Amount arithmetic still accept.
  const expectUsableAmount = (amount: Amount, expected: number) => {
    expect(Amount.from(amount).toNumber()).toBe(expected);
    expect(amount.add(Amount.from(2)).toNumber()).toBe(expected + 2);
    expect(Amount.from(2).add(amount).toNumber()).toBe(expected + 2);
  };

  it('returns a stored Amount that cashu-ts accepts, inside and outside a transaction', async () => {
    const repositories = new MemoryRepositories();
    await repositories.proofRepository.saveProofs(mintUrl, [makeProof('outside', 8)]);

    await repositories.withTransaction(async ({ proofRepository }) => {
      const [read] = await proofRepository.getProofsBySecrets(mintUrl, ['outside']);
      expectUsableAmount(read!.amount, 8);
      await proofRepository.saveProofs(mintUrl, [makeProof('inside', 16)]);
      const [written] = await proofRepository.getProofsBySecrets(mintUrl, ['inside']);
      expectUsableAmount(written!.amount, 16);
    });

    const [outside, inside] = await repositories.proofRepository.getProofsBySecrets(mintUrl, [
      'outside',
      'inside',
    ]);
    expectUsableAmount(outside!.amount, 8);
    expectUsableAmount(inside!.amount, 16);
  });
});
