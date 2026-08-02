import { describe, expect, it } from 'bun:test';
import { DerivationIndexExhaustedError } from '../../models/Error.ts';
import type { KeypairPurpose } from '../../models/Keypair.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type { RepositoryTransactionScope } from '../../repositories/index.ts';

const MAX_DERIVATION_INDEX = 0x7fffffff;

function derivedKeypair(publicKeyHex: string, derivationIndex: number, purpose: KeypairPurpose) {
  return {
    publicKeyHex,
    secretKey: new Uint8Array(32).fill((derivationIndex % 254) + 1),
    derivationIndex,
    purpose,
  };
}

describe('MemoryKeyRingRepository derivation allocation', () => {
  it('allocates exact concurrent sequences independently for each purpose', async () => {
    const repositories = new MemoryRepositories();
    const p2pk = await Promise.all(
      Array.from({ length: 50 }, () =>
        repositories.keyRingRepository.reserveNextDerivationIndex('p2pk'),
      ),
    );
    const mintQuote = await Promise.all(
      Array.from({ length: 50 }, () =>
        repositories.keyRingRepository.reserveNextDerivationIndex('nut20_mint_quote'),
      ),
    );

    expect(p2pk.sort((left, right) => left - right)).toEqual(
      Array.from({ length: 50 }, (_, index) => index),
    );
    expect(mintQuote.sort((left, right) => left - right)).toEqual(
      Array.from({ length: 50 }, (_, index) => index),
    );
  });

  it('continues above persisted indexes and never recycles gaps or deleted keys', async () => {
    const repositories = new MemoryRepositories();
    await repositories.keyRingRepository.setPersistedKeyPair(
      derivedKeypair('02' + '07'.repeat(32), 7, 'p2pk'),
    );

    await expect(repositories.keyRingRepository.reserveNextDerivationIndex('p2pk')).resolves.toBe(
      8,
    );
    const persistedIndex = await repositories.keyRingRepository.reserveNextDerivationIndex('p2pk');
    const persisted = derivedKeypair('02' + '08'.repeat(32), persistedIndex, 'p2pk');
    await repositories.keyRingRepository.setPersistedKeyPair(persisted);
    await repositories.keyRingRepository.deletePersistedKeyPair(persisted.publicKeyHex, 'p2pk');

    await expect(repositories.keyRingRepository.reserveNextDerivationIndex('p2pk')).resolves.toBe(
      10,
    );
  });

  it('fails explicitly without advancing beyond the maximum child index', async () => {
    const repositories = new MemoryRepositories();
    await repositories.keyRingRepository.setPersistedKeyPair(
      derivedKeypair('02' + '09'.repeat(32), MAX_DERIVATION_INDEX, 'nut20_mint_quote'),
    );

    await expect(
      repositories.keyRingRepository.reserveNextDerivationIndex('nut20_mint_quote'),
    ).rejects.toBeInstanceOf(DerivationIndexExhaustedError);
    await expect(
      repositories.keyRingRepository.reserveNextDerivationIndex('nut20_mint_quote'),
    ).rejects.toBeInstanceOf(DerivationIndexExhaustedError);
  });
});

function assertAllocationIsRootOnly(scope: RepositoryTransactionScope): void {
  // @ts-expect-error Irreversible allocation must not be available inside a caller transaction.
  void scope.keyRingRepository.reserveNextDerivationIndex;
}

void assertAllocationIsRootOnly;
