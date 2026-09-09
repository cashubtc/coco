import type { CoreTransactionRunner } from '../CoreTransaction.ts';
import type {
  SaveMintMetadataInput,
  SetMintTrustInput,
  SaveMintMetadataResult,
} from '../scoped/mints/ScopedMintCommands.ts';

export interface MintTransactions {
  saveMetadata(input: SaveMintMetadataInput): Promise<SaveMintMetadataResult>;
  setTrust(input: SetMintTrustInput): Promise<void>;
  delete(mintUrl: string): Promise<void>;
}

export class CoreMintTransactions implements MintTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  saveMetadata(input: SaveMintMetadataInput): Promise<SaveMintMetadataResult> {
    return this.runner.run((transaction) => transaction.mints.saveMetadata(input));
  }

  setTrust(input: SetMintTrustInput): Promise<void> {
    return this.runner.run((transaction) => transaction.mints.setTrust(input));
  }

  delete(mintUrl: string): Promise<void> {
    return this.runner.run((transaction) => transaction.mints.delete(mintUrl));
  }
}
