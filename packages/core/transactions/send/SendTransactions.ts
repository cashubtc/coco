import type {
  RollingBackSendOperation,
  RolledBackSendOperation,
} from '@core/operations/send/SendOperation.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';
import type {
  AppliedSwapResult,
  ApplySwapResultCommand,
  BegunSwapExecution,
  BeginSwapExecutionCommand,
  BeginLegacyPendingRollbackCommand,
  CancelledPreparedSend,
  CancelPreparedSendCommand,
  CleanupLegacyInitResult,
  CleanupOrphanedSendReservationsResult,
  CompletedPendingSend,
  CompletePendingSendCommand,
  CompleteLegacyPendingRollbackCommand,
  ExecuteExactSendCommand,
  ExecuteExactSendResult,
  FailedSwapExecution,
  FailSwapExecutionCommand,
  PrepareSendCommand,
  PreparedSendResult,
} from './TransactionalSendOperations.ts';

export interface SendTransactions {
  prepare(command: PrepareSendCommand): Promise<PreparedSendResult>;
  executeExact(command: ExecuteExactSendCommand): Promise<ExecuteExactSendResult>;
  beginExecution(command: BeginSwapExecutionCommand): Promise<BegunSwapExecution>;
  applyResult(command: ApplySwapResultCommand): Promise<AppliedSwapResult>;
  failExecution(command: FailSwapExecutionCommand): Promise<FailedSwapExecution>;
  cancelPrepared(command: CancelPreparedSendCommand): Promise<CancelledPreparedSend>;
  completePending(command: CompletePendingSendCommand): Promise<CompletedPendingSend>;
  cleanupOrphanedReservations(): Promise<CleanupOrphanedSendReservationsResult>;
  cleanupLegacyInit(operationId: string): Promise<CleanupLegacyInitResult>;
  beginLegacyPendingRollback(
    command: BeginLegacyPendingRollbackCommand,
  ): Promise<RollingBackSendOperation>;
  completeLegacyPendingRollback(
    command: CompleteLegacyPendingRollbackCommand,
  ): Promise<RolledBackSendOperation>;
}

export class CoreSendTransactions implements SendTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  prepare(command: PrepareSendCommand): Promise<PreparedSendResult> {
    return this.runner.run((transaction) => transaction.sends.prepare(command));
  }

  executeExact(command: ExecuteExactSendCommand): Promise<ExecuteExactSendResult> {
    return this.runner.run((transaction) => transaction.sends.executeExact(command));
  }

  beginExecution(command: BeginSwapExecutionCommand): Promise<BegunSwapExecution> {
    return this.runner.run((transaction) => transaction.sends.beginExecution(command));
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

  beginLegacyPendingRollback(
    command: BeginLegacyPendingRollbackCommand,
  ): Promise<RollingBackSendOperation> {
    return this.runner.run((transaction) => transaction.sends.beginLegacyPendingRollback(command));
  }

  completeLegacyPendingRollback(
    command: CompleteLegacyPendingRollbackCommand,
  ): Promise<RolledBackSendOperation> {
    return this.runner.run((transaction) =>
      transaction.sends.completeLegacyPendingRollback(command),
    );
  }
}
