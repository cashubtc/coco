import type { CoreTransactionRunner } from '../CoreTransaction.ts';
import type {
  AppliedSwapResult,
  BegunReclaim,
  CompletedReclaim,
  ApplySwapResultInput,
  BegunSwapExecution,
  BeginSwapExecutionInput,
  ClaimSendRecoveryInput,
  BeginReclaimInput,
  CancelledPreparedSend,
  CancelPreparedSendInput,
  CleanupLegacyInitResult,
  CleanupOrphanedSendReservationsResult,
  CompletedPendingSend,
  CompletePendingSendInput,
  CompleteReclaimInput,
  ExecuteExactSendInput,
  ExecuteExactSendResult,
  FailedSwapExecution,
  FailSwapExecutionInput,
  PrepareSendInput,
  PreparedSendResult,
} from './types.ts';

export interface SendTransactions {
  prepare(input: PrepareSendInput): Promise<PreparedSendResult>;
  executeExact(input: ExecuteExactSendInput): Promise<ExecuteExactSendResult>;
  beginExecution(input: BeginSwapExecutionInput): Promise<BegunSwapExecution>;
  claimRecovery(input: ClaimSendRecoveryInput): Promise<BegunSwapExecution>;
  applyResult(input: ApplySwapResultInput): Promise<AppliedSwapResult>;
  failExecution(input: FailSwapExecutionInput): Promise<FailedSwapExecution>;
  cancelPrepared(input: CancelPreparedSendInput): Promise<CancelledPreparedSend>;
  completePending(input: CompletePendingSendInput): Promise<CompletedPendingSend>;
  cleanupOrphanedReservations(): Promise<CleanupOrphanedSendReservationsResult>;
  cleanupLegacyInit(operationId: string): Promise<CleanupLegacyInitResult>;
  beginReclaim(input: BeginReclaimInput): Promise<BegunReclaim>;
  completeReclaim(input: CompleteReclaimInput): Promise<CompletedReclaim>;
}

export class CoreSendTransactions implements SendTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  prepare(input: PrepareSendInput): Promise<PreparedSendResult> {
    return this.runner.run((transaction) => transaction.sends.prepare(input));
  }

  executeExact(input: ExecuteExactSendInput): Promise<ExecuteExactSendResult> {
    return this.runner.run((transaction) => transaction.sends.executeExact(input));
  }

  beginExecution(input: BeginSwapExecutionInput): Promise<BegunSwapExecution> {
    return this.runner.run((transaction) => transaction.sends.beginExecution(input));
  }

  claimRecovery(input: ClaimSendRecoveryInput): Promise<BegunSwapExecution> {
    return this.runner.run((transaction) => transaction.sends.claimRecovery(input));
  }

  applyResult(input: ApplySwapResultInput): Promise<AppliedSwapResult> {
    return this.runner.run((transaction) => transaction.sends.applyResult(input));
  }

  failExecution(input: FailSwapExecutionInput): Promise<FailedSwapExecution> {
    return this.runner.run((transaction) => transaction.sends.failExecution(input));
  }

  cancelPrepared(input: CancelPreparedSendInput): Promise<CancelledPreparedSend> {
    return this.runner.run((transaction) => transaction.sends.cancelPrepared(input));
  }

  completePending(input: CompletePendingSendInput): Promise<CompletedPendingSend> {
    return this.runner.run((transaction) => transaction.sends.completePending(input));
  }

  cleanupOrphanedReservations(): Promise<CleanupOrphanedSendReservationsResult> {
    return this.runner.run((transaction) => transaction.sends.cleanupOrphanedReservations());
  }

  cleanupLegacyInit(operationId: string): Promise<CleanupLegacyInitResult> {
    return this.runner.run((transaction) => transaction.sends.cleanupLegacyInit(operationId));
  }

  beginReclaim(input: BeginReclaimInput): Promise<BegunReclaim> {
    return this.runner.run((transaction) => transaction.sends.beginReclaim(input));
  }

  completeReclaim(input: CompleteReclaimInput): Promise<CompletedReclaim> {
    return this.runner.run((transaction) => transaction.sends.completeReclaim(input));
  }
}
