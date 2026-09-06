import type { Keypair } from '@core/models/Keypair';
import { DerivationIndexExhaustedError } from '@core/models/Error';
import type { KeyRingRepository } from '@core/repositories';
import type { AllocateKeypairCommand } from '../../../keypairs/types.ts';

const MAX_DERIVATION_INDEX = 0x7fffffff;

/** Keypair mutations within the owning transaction; these commands never open a transaction. */
export interface ScopedKeypairCommands {
  /** Await each allocation before starting another for the same purpose within this scope. */
  allocate(command: AllocateKeypairCommand): Promise<Keypair>;
  importP2pk(keypair: Keypair): Promise<void>;
  deleteP2pk(publicKey: string): Promise<void>;
}

export class RepositoryKeypairCommands implements ScopedKeypairCommands {
  constructor(private readonly repository: KeyRingRepository) {}

  async allocate(command: AllocateKeypairCommand): Promise<Keypair> {
    const lastAllocatedIndex = await this.repository.getLastAllocatedIndex(command.purpose);
    const highestStoredIndex = await this.repository.getHighestStoredDerivationIndex(
      command.purpose,
    );
    const previousIndex = Math.max(lastAllocatedIndex ?? -1, highestStoredIndex ?? -1);
    if (previousIndex >= MAX_DERIVATION_INDEX) {
      throw new DerivationIndexExhaustedError(command.purpose);
    }

    const derivationIndex = previousIndex + 1;
    const keypair = {
      ...command.derive(derivationIndex),
      derivationIndex,
      purpose: command.purpose,
    };
    await this.repository.setPersistedKeyPair(keypair);
    await this.repository.setLastAllocatedIndex(command.purpose, derivationIndex);
    return keypair;
  }

  importP2pk(keypair: Keypair): Promise<void> {
    return this.repository.setPersistedKeyPair(keypair);
  }

  deleteP2pk(publicKey: string): Promise<void> {
    return this.repository.deletePersistedKeyPair(publicKey, 'p2pk');
  }
}
