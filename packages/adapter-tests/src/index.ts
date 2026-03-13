import type { Mint, Keyset, CoreProof, MeltOperation, CocoStorage } from 'coco-cashu-core';
import { getStorageRepositories, withStorageTransaction } from 'coco-cashu-core/adapter';

type TransactionFactory<TStorage extends CocoStorage = CocoStorage> = () => Promise<{
  repositories: TStorage;
  dispose(): Promise<void>;
}>;

type ContractOptions<TStorage extends CocoStorage = CocoStorage> = {
  createRepositories: TransactionFactory<TStorage>;
};

export async function runRepositoryTransactionContract(
  options: ContractOptions,
  runner: ContractRunner,
): Promise<void> {
  const { describe, it, expect } = runner;

  describe('repository transactions contract', () => {
    it('commits all repositories together', async () => {
      const { repositories: storage, dispose } = await options.createRepositories();
      try {
        let committed = false;
        await withStorageTransaction(storage, async (tx) => {
          await tx.mintRepository.addOrUpdateMint(createDummyMint());
          await tx.keysetRepository.addKeyset(createDummyKeyset());
          await tx.proofRepository.saveProofs('https://mint.test', [createDummyProof()]);
          await tx.meltOperationRepository.create(createDummyMeltOperation());
          committed = true;
        });

        expect(committed).toBe(true);
        const repositories = getStorageRepositories(storage);
        const stored = await repositories.proofRepository.getAllReadyProofs();
        expect(stored.length).toBeGreaterThan(0);
        const operation = await repositories.meltOperationRepository.getById('melt-op');
        expect(operation).toBeDefined();
      } finally {
        await dispose();
      }
    });

    it('rolls back commits on error', async () => {
      const { repositories: storage, dispose } = await options.createRepositories();
      try {
        await expectThrows(async () => {
          await withStorageTransaction(storage, async (tx) => {
            await tx.mintRepository.addOrUpdateMint(createDummyMint());
            throw new Error('boom');
          });
        }, expect);

        const repositories = getStorageRepositories(storage);
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
  toBeDefined(): void;
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

export function createDummyMeltOperation(): MeltOperation {
  return {
    id: 'melt-op',
    state: 'init',
    mintUrl: 'https://mint.test',
    method: 'bolt11',
    methodData: { invoice: 'lnbc1test' },
    createdAt: 0,
    updatedAt: 0,
  } satisfies MeltOperation;
}

export { runIntegrationTests } from './integration.ts';
export type { IntegrationTestRunner, IntegrationTestOptions } from './integration.ts';
// Migration tests temporarily disabled - architecture being reconsidered
// export { runMigrationTests } from './migrations.ts';
// export type { MigrationTestRunner, MigrationTestOptions } from './migrations.ts';
export { createFakeInvoice } from 'fake-bolt11';
export type { FakeInvoiceOptions } from 'fake-bolt11';
