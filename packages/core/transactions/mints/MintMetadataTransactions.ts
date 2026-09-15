import type {
  MintMetadataApplyResult,
  ApplyMintMetadataInput,
  RegisterMintInput,
  MintRegistrationResult,
} from '@core/mints/MintMetadata.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';

export interface MintMetadataTransactions {
  invalidate(mintUrl: string): Promise<void>;
  applyObservation(observation: ApplyMintMetadataInput): Promise<MintMetadataApplyResult>;
  register(input: RegisterMintInput): Promise<MintRegistrationResult>;
}

export class CoreMintMetadataTransactions implements MintMetadataTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  invalidate(mintUrl: string): Promise<void> {
    return this.runner.run((transaction) => transaction.mintMetadata.invalidate(mintUrl));
  }

  applyObservation(observation: ApplyMintMetadataInput): Promise<MintMetadataApplyResult> {
    return this.runner.run((transaction) => transaction.mintMetadata.applyObservation(observation));
  }

  register(input: RegisterMintInput): Promise<MintRegistrationResult> {
    return this.runner.run((transaction) => transaction.mintMetadata.register(input));
  }
}
