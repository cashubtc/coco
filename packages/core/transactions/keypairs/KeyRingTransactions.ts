import type { Keypair } from '@core/models/Keypair';
import type { AllocateKeypairInput } from '../../keypairs/types.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';

/** Each key-management command owns one transaction and resolves after commit. */
export interface KeyRingTransactions {
  allocate(input: AllocateKeypairInput): Promise<Keypair>;
  /** Returns the persisted keypair, retaining an existing canonical or legacy identity. */
  importP2pkKey(keypair: Keypair): Promise<Keypair>;
  deleteP2pkKey(publicKey: string): Promise<void>;
}

export class CoreKeyRingTransactions implements KeyRingTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  allocate(input: AllocateKeypairInput): Promise<Keypair> {
    return this.runner.run((transaction) => transaction.keypairs.allocate(input));
  }

  importP2pkKey(keypair: Keypair): Promise<Keypair> {
    return this.runner.run((transaction) => transaction.keypairs.importP2pk(keypair));
  }

  deleteP2pkKey(publicKey: string): Promise<void> {
    return this.runner.run((transaction) => transaction.keypairs.deleteP2pk(publicKey));
  }
}
