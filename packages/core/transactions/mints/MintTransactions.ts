import type { MintMetadataApplyResult, MintMetadataObservation } from '@core/mints/MintMetadata.ts';
import type {
  AddMintInput,
  AddMintResult,
  SetMintTrustedInput,
} from '../scoped/mints/ScopedMintCommands.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';

export interface MintTransactions {
  applyObservation(observation: MintMetadataObservation): Promise<MintMetadataApplyResult>;
  updateMetadata(observation: MintMetadataObservation): Promise<MintMetadataApplyResult>;
  add(input: AddMintInput): Promise<AddMintResult>;
  setTrusted(input: SetMintTrustedInput): Promise<void>;
  delete(mintUrl: string): Promise<void>;
}

export class CoreMintTransactions implements MintTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  applyObservation(observation: MintMetadataObservation): Promise<MintMetadataApplyResult> {
    return this.runner.run((transaction) => transaction.mints.applyObservation(observation));
  }

  updateMetadata(observation: MintMetadataObservation): Promise<MintMetadataApplyResult> {
    return this.runner.run((transaction) => transaction.mints.updateMetadata(observation));
  }

  add(input: AddMintInput): Promise<AddMintResult> {
    return this.runner.run((transaction) => transaction.mints.add(input));
  }

  setTrusted(input: SetMintTrustedInput): Promise<void> {
    return this.runner.run((transaction) => transaction.mints.setTrusted(input));
  }

  delete(mintUrl: string): Promise<void> {
    return this.runner.run((transaction) => transaction.mints.delete(mintUrl));
  }
}
