import type { Keypair, KeypairPurpose } from '@core/models/Keypair';
import type { KeyRingRepository } from '@core/repositories';

export type PurposeBoundKeyDeriver = (
  derivationIndex: number,
) => Pick<Keypair, 'publicKeyHex' | 'secretKey'>;

export interface AllocateKeypairCommand {
  purpose: KeypairPurpose;
  derive: PurposeBoundKeyDeriver;
}

export interface TransactionalKeypairOperations {
  allocate(command: AllocateKeypairCommand): Promise<Keypair>;
  importP2pk(keypair: Keypair): Promise<void>;
  deleteP2pk(publicKey: string): Promise<void>;
}

export class RepositoryTransactionalKeypairOperations implements TransactionalKeypairOperations {
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
