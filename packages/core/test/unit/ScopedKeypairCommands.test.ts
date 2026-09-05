import { describe, expect, it } from 'bun:test';
import { DerivationIndexExhaustedError } from '../../models/Error.ts';
import type { KeypairPurpose } from '../../models/Keypair.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type { Repositories, RepositoryTransactionScope } from '../../repositories/index.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreKeyRingTransactions } from '../../transactions/keypairs/KeyRingTransactions.ts';

const MAX_DERIVATION_INDEX = 0x7fffffff;

function derivedKeypair(derivationIndex: number, purpose: KeypairPurpose) {
  const prefix = purpose === 'p2pk' ? '02' : '03';
  return {
    publicKeyHex: prefix + derivationIndex.toString(16).padStart(64, '0'),
    secretKey: new Uint8Array(32).fill((derivationIndex % 254) + 1),
    derivationIndex,
    purpose,
  };
}

function allocate(
  repositories: Repositories,
  purpose: KeypairPurpose,
  derive = (index: number) => derivedKeypair(index, purpose),
) {
  const gateway = new CoreKeyRingTransactions(new RepositoryCoreTransactionRunner(repositories));
  return gateway.allocate({ purpose, derive });
}

describe('ScopedKeypairCommands allocation', () => {
  it('reads authoritative allocation state before deriving and does not lower its high-water mark', async () => {
    const repositories = new MemoryRepositories();
    await repositories.keyRingRepository.setPersistedKeyPair(derivedKeypair(7, 'p2pk'));
    await repositories.keyRingRepository.setLastAllocatedIndex('p2pk', 12);
    const keypair = await allocate(repositories, 'p2pk', (index) => {
      expect(index).toBe(13);
      return derivedKeypair(index, 'p2pk');
    });
    expect(keypair.derivationIndex).toBe(13);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(13);
    expect(
      await repositories.keyRingRepository.getLastAllocatedIndex('nut20_mint_quote'),
    ).toBeNull();
  });

  it('does not derive or persist when the durable high-water mark is exhausted', async () => {
    const repositories = new MemoryRepositories();
    await repositories.keyRingRepository.setLastAllocatedIndex('p2pk', MAX_DERIVATION_INDEX);
    let derived = false;
    await expect(
      allocate(repositories, 'p2pk', (index) => {
        derived = true;
        return derivedKeypair(index, 'p2pk');
      }),
    ).rejects.toBeInstanceOf(DerivationIndexExhaustedError);
    expect(derived).toBe(false);
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(
      MAX_DERIVATION_INDEX,
    );
  });
  it('allocates exact concurrent sequences independently for each purpose', async () => {
    const repositories = new MemoryRepositories();
    const p2pk = await Promise.all(
      Array.from({ length: 50 }, () => allocate(repositories, 'p2pk')),
    );
    const mintQuote = await Promise.all(
      Array.from({ length: 50 }, () => allocate(repositories, 'nut20_mint_quote')),
    );

    expect(p2pk.map((key) => key.derivationIndex).sort((left, right) => left! - right!)).toEqual(
      Array.from({ length: 50 }, (_, index) => index),
    );
    expect(
      mintQuote.map((key) => key.derivationIndex).sort((left, right) => left! - right!),
    ).toEqual(Array.from({ length: 50 }, (_, index) => index));
  });

  it('continues above persisted indexes and never recycles gaps or deleted keys', async () => {
    const repositories = new MemoryRepositories();
    await repositories.keyRingRepository.setPersistedKeyPair(derivedKeypair(7, 'p2pk'));

    const persisted = await allocate(repositories, 'p2pk');
    expect(persisted.derivationIndex).toBe(8);
    await repositories.keyRingRepository.deletePersistedKeyPair(persisted.publicKeyHex, 'p2pk');

    await expect(allocate(repositories, 'p2pk')).resolves.toMatchObject({
      derivationIndex: 9,
    });
  });

  it('reuses an unexposed index after derivation fails', async () => {
    const repositories = new MemoryRepositories();
    await expect(
      allocate(repositories, 'p2pk', () => {
        throw new Error('derivation failed');
      }),
    ).rejects.toThrow('derivation failed');

    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
    await expect(allocate(repositories, 'p2pk')).resolves.toMatchObject({
      derivationIndex: 0,
    });
  });

  it('fails explicitly without advancing beyond the maximum child index', async () => {
    const repositories = new MemoryRepositories();
    await repositories.keyRingRepository.setPersistedKeyPair(
      derivedKeypair(MAX_DERIVATION_INDEX, 'nut20_mint_quote'),
    );

    await expect(allocate(repositories, 'nut20_mint_quote')).rejects.toBeInstanceOf(
      DerivationIndexExhaustedError,
    );
    await expect(allocate(repositories, 'nut20_mint_quote')).rejects.toBeInstanceOf(
      DerivationIndexExhaustedError,
    );
  });
});

function scopedRepositoryAuthority(scope: RepositoryTransactionScope): void {
  // @ts-expect-error Derivation belongs to scoped commands, never to a repository.
  void scope.keyRingRepository.deriveAndPersistKeyPair;
}
void scopedRepositoryAuthority;

describe('ScopedKeypairCommands transaction scope', () => {
  it('allocates distinct indexes when composed callers share one scope concurrently', async () => {
    const repositories = new MemoryRepositories();
    const keys = await new RepositoryCoreTransactionRunner(repositories).run((scope) =>
      Promise.all(
        Array.from({ length: 5 }, () =>
          scope.keypairs.allocate({
            purpose: 'p2pk',
            derive: (index) => derivedKeypair(index, 'p2pk'),
          }),
        ),
      ),
    );
    expect(keys.map((key) => key.derivationIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toHaveLength(5);
  });
  it('rolls back a persisted key if advancing the high-water mark fails', async () => {
    const repositories = new MemoryRepositories();
    const first = await allocate(repositories, 'p2pk');
    const failing = new Proxy(repositories, {
      get(target, property, receiver) {
        if (property === 'withTransaction') {
          return <T>(command: (scope: RepositoryTransactionScope) => Promise<T>) =>
            repositories.withTransaction((scope) => {
              scope.keyRingRepository.setLastAllocatedIndex = async () => {
                throw new Error('high-water write failed');
              };
              return command(scope);
            });
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(allocate(failing, 'p2pk')).rejects.toThrow('high-water write failed');
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([first]);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(0);
    expect((await allocate(repositories, 'p2pk')).derivationIndex).toBe(1);
  });
  it('rolls key allocation back with the enclosing Wallet transaction', async () => {
    const repositories = new MemoryRepositories();

    await expect(
      new RepositoryCoreTransactionRunner(repositories).run(async (scope) => {
        await scope.keypairs.allocate({
          purpose: 'p2pk',
          derive: (index) => derivedKeypair(index, 'p2pk'),
        });
        throw new Error('abort Wallet transaction');
      }),
    ).rejects.toThrow('abort Wallet transaction');

    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
  });
});
