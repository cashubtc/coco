import type { MintMetadata, MintMetadataObservation } from '@core/mints/MintMetadata.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';
import type {
  AppliedSwapResult,
  BegunReclaim,
  CompletedReclaim,
  ApplySwapResultCommand,
  BegunSwapExecution,
  BeginSwapExecutionCommand,
  ClaimSendRecoveryCommand,
  BeginReclaimCommand,
  CancelledPreparedSend,
  CancelPreparedSendCommand,
  CleanupLegacyInitResult,
  CleanupOrphanedSendReservationsResult,
  CompletedPendingSend,
  CompletePendingSendCommand,
  CompleteReclaimCommand,
  ExecuteExactSendCommand,
  ExecuteExactSendResult,
  FailedSwapExecution,
  FailSwapExecutionCommand,
  PrepareSendCommand,
  PreparedSendResult,
} from './types.ts';

export interface SendTransactions {
  refreshMintMetadata(observation: MintMetadataObservation): Promise<MintMetadata>;
  prepare(command: PrepareSendCommand): Promise<PreparedSendResult>;
  executeExact(command: ExecuteExactSendCommand): Promise<ExecuteExactSendResult>;
  beginExecution(command: BeginSwapExecutionCommand): Promise<BegunSwapExecution>;
  claimRecovery(command: ClaimSendRecoveryCommand): Promise<BegunSwapExecution>;
  applyResult(command: ApplySwapResultCommand): Promise<AppliedSwapResult>;
  failExecution(command: FailSwapExecutionCommand): Promise<FailedSwapExecution>;
  cancelPrepared(command: CancelPreparedSendCommand): Promise<CancelledPreparedSend>;
  completePending(command: CompletePendingSendCommand): Promise<CompletedPendingSend>;
  cleanupOrphanedReservations(): Promise<CleanupOrphanedSendReservationsResult>;
  cleanupLegacyInit(operationId: string): Promise<CleanupLegacyInitResult>;
  beginReclaim(command: BeginReclaimCommand): Promise<BegunReclaim>;
  completeReclaim(command: CompleteReclaimCommand): Promise<CompletedReclaim>;
}

export class CoreSendTransactions implements SendTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  refreshMintMetadata(observation: MintMetadataObservation): Promise<MintMetadata> {
    return this.runner.run((transaction) => transaction.mintMetadata.applyObservation(observation));
  }

  prepare(command: PrepareSendCommand): Promise<PreparedSendResult> {
    return this.runner.run((transaction) => transaction.sends.prepare(command));
  }

  executeExact(command: ExecuteExactSendCommand): Promise<ExecuteExactSendResult> {
    return this.runner.run((transaction) => transaction.sends.executeExact(command));
  }

  beginExecution(command: BeginSwapExecutionCommand): Promise<BegunSwapExecution> {
    return this.runner.run((transaction) => transaction.sends.beginExecution(command));
  }

  claimRecovery(command: ClaimSendRecoveryCommand): Promise<BegunSwapExecution> {
    return this.runner.run((transaction) => transaction.sends.claimRecovery(command));
  }

  applyResult(command: ApplySwapResultCommand): Promise<AppliedSwapResult> {
    return this.runner.run((transaction) => transaction.sends.applyResult(command));
  }

  failExecution(command: FailSwapExecutionCommand): Promise<FailedSwapExecution> {
    return this.runner.run((transaction) => transaction.sends.failExecution(command));
  }

  cancelPrepared(command: CancelPreparedSendCommand): Promise<CancelledPreparedSend> {
    return this.runner.run((transaction) => transaction.sends.cancelPrepared(command));
  }

  completePending(command: CompletePendingSendCommand): Promise<CompletedPendingSend> {
    return this.runner.run((transaction) => transaction.sends.completePending(command));
  }

  cleanupOrphanedReservations(): Promise<CleanupOrphanedSendReservationsResult> {
    return this.runner.run((transaction) => transaction.sends.cleanupOrphanedReservations());
  }

  cleanupLegacyInit(operationId: string): Promise<CleanupLegacyInitResult> {
    return this.runner.run((transaction) => transaction.sends.cleanupLegacyInit(operationId));
  }

  beginReclaim(command: BeginReclaimCommand): Promise<BegunReclaim> {
    return this.runner.run((transaction) => transaction.sends.beginReclaim(command));
  }

  completeReclaim(command: CompleteReclaimCommand): Promise<CompletedReclaim> {
    return this.runner.run((transaction) => transaction.sends.completeReclaim(command));
  }
}
