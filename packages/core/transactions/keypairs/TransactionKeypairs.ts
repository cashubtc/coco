import type { Keypair } from '@core/models/Keypair';
import { DerivationIndexExhaustedError } from '@core/models/Error';
import type { KeyRingRepository } from '@core/repositories';
import type { AllocateKeypairInput } from '../../keypairs/types.ts';

const MAX_DERIVATION_INDEX = 0x7fffffff;

/** Keypair mutations within the owning transaction; these commands never open a transaction. */
export interface TransactionKeypairs {
  /** Await each allocation before starting another for the same purpose within this scope. */
  getMintQuoteKey(publicKey: string): Promise<Keypair | null>;
  allocate(input: AllocateKeypairInput): Promise<Keypair>;
  importP2pk(keypair: Keypair): Promise<void>;
  deleteP2pk(publicKey: string): Promise<void>;
}

export class RepositoryTransactionKeypairs implements TransactionKeypairs {
  constructor(private readonly repository: KeyRingRepository) {}

  getMintQuoteKey(publicKey: string): Promise<Keypair | null> {
    return this.repository.getPersistedKeyPair(publicKey, 'nut20_mint_quote');
  }

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

  importP2pk(keypair: Keypair): Promise<void> {
    return this.repository.setPersistedKeyPair(keypair);
  }

  deleteP2pk(publicKey: string): Promise<void> {
    return this.repository.deletePersistedKeyPair(publicKey, 'p2pk');
  }
}
