import type { MintMetadataApplyResult, ApplyMintMetadataInput } from '@core/mints/MintMetadata.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';

export interface MintMetadataTransactions {
  invalidate(mintUrl: string): Promise<void>;
  applyObservation(observation: ApplyMintMetadataInput): Promise<MintMetadataApplyResult>;
}

export class CoreMintMetadataTransactions implements MintMetadataTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  invalidate(mintUrl: string): Promise<void> {
    return this.runner.run((transaction) => transaction.mintMetadata.invalidate(mintUrl));
  }

  applyObservation(observation: ApplyMintMetadataInput): Promise<MintMetadataApplyResult> {
    return this.runner.run((transaction) => transaction.mintMetadata.applyObservation(observation));
  }
}
