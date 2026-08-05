import { describe, expect, it } from 'bun:test';
import { DerivationIndexExhaustedError } from '../../models/Error.ts';
import type { KeypairPurpose } from '../../models/Keypair.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type { RepositoryTransactionScope } from '../../repositories/index.ts';

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

function deriveNext(repository: MemoryRepositories['keyRingRepository'], purpose: KeypairPurpose) {
  return repository.deriveAndPersistKeyPair(purpose, (index) => derivedKeypair(index, purpose));
}

describe('MemoryKeyRingRepository derivation persistence', () => {
  it('allocates exact concurrent sequences independently for each purpose', async () => {
    const repositories = new MemoryRepositories();
    const p2pk = await Promise.all(
      Array.from({ length: 50 }, () => deriveNext(repositories.keyRingRepository, 'p2pk')),
    );
    const mintQuote = await Promise.all(
      Array.from({ length: 50 }, () =>
        deriveNext(repositories.keyRingRepository, 'nut20_mint_quote'),
      ),
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

    const persisted = await deriveNext(repositories.keyRingRepository, 'p2pk');
    expect(persisted.derivationIndex).toBe(8);
    await repositories.keyRingRepository.deletePersistedKeyPair(persisted.publicKeyHex, 'p2pk');

    await expect(deriveNext(repositories.keyRingRepository, 'p2pk')).resolves.toMatchObject({
      derivationIndex: 9,
    });
  });

  it('reuses an unexposed index after derivation fails', async () => {
    const repositories = new MemoryRepositories();
    await expect(
      repositories.keyRingRepository.deriveAndPersistKeyPair('p2pk', () => {
        throw new Error('derivation failed');
      }),
    ).rejects.toThrow('derivation failed');

    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
    await expect(deriveNext(repositories.keyRingRepository, 'p2pk')).resolves.toMatchObject({
      derivationIndex: 0,
    });
  });

  it('fails explicitly without advancing beyond the maximum child index', async () => {
    const repositories = new MemoryRepositories();
    await repositories.keyRingRepository.setPersistedKeyPair(
      derivedKeypair(MAX_DERIVATION_INDEX, 'nut20_mint_quote'),
    );

    await expect(
      deriveNext(repositories.keyRingRepository, 'nut20_mint_quote'),
    ).rejects.toBeInstanceOf(DerivationIndexExhaustedError);
    await expect(
      deriveNext(repositories.keyRingRepository, 'nut20_mint_quote'),
    ).rejects.toBeInstanceOf(DerivationIndexExhaustedError);
  });
});

function assertAtomicDerivationIsRootOnly(scope: RepositoryTransactionScope): void {
  // @ts-expect-error A generated key must not be exposed before its own transaction commits.
  void scope.keyRingRepository.deriveAndPersistKeyPair;
}

void assertAtomicDerivationIsRootOnly;
