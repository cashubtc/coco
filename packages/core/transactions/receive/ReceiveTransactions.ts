import type { ReceiveOperation } from '@core/operations/receive/ReceiveOperation.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';
import type {
  PrepareReceiveCommand,
  PreparedReceiveResult,
} from './TransactionalReceiveOperations.ts';

export interface ReceiveTransactions {
  prepare(command: PrepareReceiveCommand): Promise<PreparedReceiveResult>;
  updateLegacyOperation(operation: ReceiveOperation): Promise<void>;
  deleteLegacyInit(operationId: string): Promise<void>;
}

export class CoreReceiveTransactions implements ReceiveTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  prepare(command: PrepareReceiveCommand): Promise<PreparedReceiveResult> {
    return this.runner.run((transaction) => transaction.receives.prepare(command));
  }

  updateLegacyOperation(operation: ReceiveOperation): Promise<void> {
    return this.runner.run((transaction) => transaction.receives.updateLegacyOperation(operation));
  }

  deleteLegacyInit(operationId: string): Promise<void> {
    return this.runner.run((transaction) => transaction.receives.deleteLegacyInit(operationId));
  }
}
