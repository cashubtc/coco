import type { Keypair } from '@core/models/Keypair';
import type { KeyRingRepository } from '@core/repositories';
import type { AllocateKeypairCommand } from '../../../keypairs/types.ts';

/** Keypair mutations within the owning transaction; these commands never open a transaction. */
export interface ScopedKeypairCommands {
  allocate(command: AllocateKeypairCommand): Promise<Keypair>;
  importP2pk(keypair: Keypair): Promise<void>;
  deleteP2pk(publicKey: string): Promise<void>;
}

export class RepositoryKeypairCommands implements ScopedKeypairCommands {
  constructor(private readonly repository: KeyRingRepository) {}

  allocate(command: AllocateKeypairCommand): Promise<Keypair> {
    return this.repository.deriveAndPersistKeyPair(command.purpose, command.derive);
  }

  importP2pk(keypair: Keypair): Promise<void> {
    return this.repository.setPersistedKeyPair(keypair);
  }

  deleteP2pk(publicKey: string): Promise<void> {
    return this.repository.deletePersistedKeyPair(publicKey, 'p2pk');
  }
}
