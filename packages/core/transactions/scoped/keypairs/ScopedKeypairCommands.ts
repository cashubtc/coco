import type { Keypair } from '@core/models/Keypair';
import { DerivationIndexExhaustedError } from '@core/models/Error';
import type { KeyRingRepository } from '@core/repositories';
import type { AllocateKeypairInput } from '../../../keypairs/types.ts';
import { findP2pkKeyPair } from '../../../keypairs/P2pkKeyLookup.ts';

const MAX_DERIVATION_INDEX = 0x7fffffff;

/** Keypair mutations within the owning transaction; these commands never open a transaction. */
export interface ScopedKeypairCommands {
  /** Await each allocation before starting another for the same purpose within this scope. */
  allocate(input: AllocateKeypairInput): Promise<Keypair>;
  /** Resolves aliases inside this scope and returns the persisted identity and metadata. */
  importP2pk(keypair: Keypair): Promise<Keypair>;
  deleteP2pk(publicKey: string): Promise<void>;
}

export class RepositoryKeypairCommands implements ScopedKeypairCommands {
  constructor(private readonly repository: KeyRingRepository) {}

  async allocate(input: AllocateKeypairInput): Promise<Keypair> {
    const lastAllocatedIndex = await this.repository.getLastAllocatedIndex(input.purpose);
    const highestStoredIndex = await this.repository.getHighestStoredDerivationIndex(input.purpose);
    const previousIndex = Math.max(lastAllocatedIndex ?? -1, highestStoredIndex ?? -1);
    if (previousIndex >= MAX_DERIVATION_INDEX) {
      throw new DerivationIndexExhaustedError(input.purpose);
    }

    const derivationIndex = previousIndex + 1;
    const keypair = {
      ...input.derive(derivationIndex),
      derivationIndex,
      purpose: input.purpose,
    };
    await this.repository.setPersistedKeyPair(keypair);
    await this.repository.setLastAllocatedIndex(input.purpose, derivationIndex);
    return keypair;
  }

  async importP2pk(keypair: Keypair): Promise<Keypair> {
    const existing = await findP2pkKeyPair(this.repository, keypair.publicKeyHex);
    if (existing) return existing;
    await this.repository.setPersistedKeyPair(keypair);
    return keypair;
  }

  async deleteP2pk(publicKey: string): Promise<void> {
    const existing = await findP2pkKeyPair(this.repository, publicKey);
    if (existing) await this.repository.deletePersistedKeyPair(existing.publicKeyHex, 'p2pk');
  }
}
