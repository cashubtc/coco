import type { Mint, Keyset, CoreProof, Repositories } from 'coco-cashu-core';

type TransactionFactory<TRepositories extends Repositories = Repositories> = () => Promise<{
  repositories: TRepositories;
  dispose(): Promise<void>;
}>;

type ContractOptions<TRepositories extends Repositories = Repositories> = {
  createRepositories: TransactionFactory<TRepositories>;
};

export async function runRepositoryTransactionContract(
  options: ContractOptions,
  runner: ContractRunner,
): Promise<void> {
  const { describe, it, expect } = runner;

  describe('repository transactions contract', () => {
    it('commits all repositories together', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        let committed = false;
        await repositories.withTransaction(async (tx) => {
          await tx.mintRepository.addOrUpdateMint(createDummyMint());
          await tx.keysetRepository.addKeyset(createDummyKeyset());
          await tx.proofRepository.saveProofs('https://mint.test', [createDummyProof()]);
          committed = true;
        });

        expect(committed).toBe(true);
        const stored = await repositories.proofRepository.getAllReadyProofs();
        expect(stored.length).toBeGreaterThan(0);
      } finally {
        await dispose();
      }
    });

    it('rolls back commits on error', async () => {
      const { repositories, dispose } = await options.createRepositories();
      try {
        await expectThrows(async () => {
          await repositories.withTransaction(async (tx) => {
            await tx.mintRepository.addOrUpdateMint(createDummyMint());
            throw new Error('boom');
          });
        }, expect);

        const mints = await repositories.mintRepository.getAllMints();
        expect(mints.length).toBe(0);
      } finally {
        await dispose();
      }
    });
  });
}

export type ContractRunner = {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  expect: Expectation;
};

type Expectation = {
  (value: unknown): ExpectApi;
};

type ExpectApi = {
  toBe(value: unknown): void;
  toHaveLength(len: number): void;
  toBeGreaterThan(value: number): void;
};

async function expectThrows(fn: () => Promise<void>, expect: Expectation) {
  let didThrow = false;
  try {
    await fn();
  } catch (error) {
    didThrow = true;
  }
  expect(didThrow).toBe(true);
}

export function createDummyMint(): Mint {
  return {
    mintUrl: 'https://mint.test',
    name: 'Test Mint',
    mintInfo: {
      name: 'Test Mint',
      pubkey: 'pubkey',
      version: '1.0',
      contact: {},
      nuts: {},
    } as Mint['mintInfo'],
    trusted: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function createDummyKeyset(): Keyset {
  return {
    mintUrl: 'https://mint.test',
    id: 'keyset-id',
    unit: 'sat',
    keypairs: {},
    active: true,
    feePpk: 0,
    updatedAt: 0,
  };
}

export function createDummyProof(): CoreProof {
  return {
    id: 'proof-id',
    amount: 1,
    secret: 'secret',
    C: 'C',
    mintUrl: 'https://mint.test',
    state: 'ready',
  } satisfies CoreProof;
}
