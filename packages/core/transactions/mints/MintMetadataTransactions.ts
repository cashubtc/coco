import type { MintMetadata, MintMetadataObservation } from '@core/mints/MintMetadata.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';

export interface MintMetadataTransactions {
  applyObservation(observation: MintMetadataObservation): Promise<MintMetadata>;
}

export class CoreMintMetadataTransactions implements MintMetadataTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  applyObservation(observation: MintMetadataObservation): Promise<MintMetadata> {
    return this.runner.run((transaction) => transaction.mintMetadata.applyObservation(observation));
  }
}
