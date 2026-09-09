import type {
  MintCommands,
  PrepareMintInput,
  AuthorizeMintInput,
} from '../../operations/mint/MintCommands.ts';
import type { MintIssuanceReceipt } from '../../operations/mint/MintRecovery.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';

export interface MintTransactions extends MintCommands {}

/** Every method opens exactly one transaction; all effects are owned by its scoped input. */
export class CoreMintTransactions implements MintTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}
  prepare(input: PrepareMintInput) {
    return this.runner.run((tx) => tx.mints.prepare(input));
  }
  authorize(input: AuthorizeMintInput) {
    return this.runner.run((tx) => tx.mints.authorize(input));
  }
  migrate(operationId: string) {
    return this.runner.run((tx) => tx.mints.migrate(operationId));
  }
  applyEvidence(operationId: string, receipts: MintIssuanceReceipt[]) {
    return this.runner.run((tx) => tx.mints.applyEvidence(operationId, receipts));
  }
  reject(operationId: string, revision: number, error: string, useLegacy: boolean) {
    return this.runner.run((tx) => tx.mints.reject(operationId, revision, error, useLegacy));
  }
  noteAmbiguity(operationId: string, revision: number, error: string) {
    return this.runner.run((tx) => tx.mints.noteAmbiguity(operationId, revision, error));
  }
}
