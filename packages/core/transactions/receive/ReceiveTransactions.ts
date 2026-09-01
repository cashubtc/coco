import type { CoreTransactionRunner } from '../CoreTransaction.ts';
import type {
  AppliedReceiveResult,
  ApplyReceiveResultCommand,
  BegunReceiveExecution,
  BeginReceiveExecutionCommand,
  CancelPreparedReceiveCommand,
  FailedReceiveExecution,
  FailReceiveExecutionCommand,
  PrepareReceiveCommand,
  PreparedReceiveResult,
} from './TransactionalReceiveOperations.ts';

export interface ReceiveTransactions {
  prepare(command: PrepareReceiveCommand): Promise<PreparedReceiveResult>;
  beginExecution(command: BeginReceiveExecutionCommand): Promise<BegunReceiveExecution>;
  applyResult(command: ApplyReceiveResultCommand): Promise<AppliedReceiveResult>;
  failExecution(command: FailReceiveExecutionCommand): Promise<FailedReceiveExecution>;
  cancelPrepared(command: CancelPreparedReceiveCommand): Promise<FailedReceiveExecution>;
  deleteLegacyInit(operationId: string): Promise<void>;
}

export class CoreReceiveTransactions implements ReceiveTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  prepare(command: PrepareReceiveCommand): Promise<PreparedReceiveResult> {
    return this.runner.run((transaction) => transaction.receives.prepare(command));
  }

  beginExecution(command: BeginReceiveExecutionCommand): Promise<BegunReceiveExecution> {
    return this.runner.run((transaction) => transaction.receives.beginExecution(command));
  }

  applyResult(command: ApplyReceiveResultCommand): Promise<AppliedReceiveResult> {
    return this.runner.run((transaction) => transaction.receives.applyResult(command));
  }

  failExecution(command: FailReceiveExecutionCommand): Promise<FailedReceiveExecution> {
    return this.runner.run((transaction) => transaction.receives.failExecution(command));
  }

  cancelPrepared(command: CancelPreparedReceiveCommand): Promise<FailedReceiveExecution> {
    return this.runner.run((transaction) => transaction.receives.cancelPrepared(command));
  }

  deleteLegacyInit(operationId: string): Promise<void> {
    return this.runner.run((transaction) => transaction.receives.deleteLegacyInit(operationId));
  }
}
