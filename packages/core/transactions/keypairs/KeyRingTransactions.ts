import type { Keypair } from '@core/models/Keypair';
import type { AllocateKeypairCommand } from '../../keypairs/types.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';

/** Each key-management command owns one transaction and resolves after commit. */
export interface KeyRingTransactions {
  allocate(command: AllocateKeypairCommand): Promise<Keypair>;
  importP2pkKey(keypair: Keypair): Promise<void>;
  deleteP2pkKey(publicKey: string): Promise<void>;
}

export class CoreKeyRingTransactions implements KeyRingTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  allocate(command: AllocateKeypairCommand): Promise<Keypair> {
    return this.runner.run((transaction) => transaction.keypairs.allocate(command));
  }

  importP2pkKey(keypair: Keypair): Promise<void> {
    return this.runner.run((transaction) => transaction.keypairs.importP2pk(keypair));
  }

  deleteP2pkKey(publicKey: string): Promise<void> {
    return this.runner.run((transaction) => transaction.keypairs.deleteP2pk(publicKey));
  }
}
