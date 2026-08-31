import type { SendOperation } from '@core/operations/send/SendOperation.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';
import type { PrepareSendCommand, PreparedSendResult } from './TransactionalSendOperations.ts';

export interface SendTransactions {
  prepare(command: PrepareSendCommand): Promise<PreparedSendResult>;
  /** Temporary runner-backed compatibility seam for lifecycle slices #450-#452. */
  updateLegacyState(operation: SendOperation): Promise<void>;
  /** Temporary runner-backed compatibility seam for persisted legacy init cleanup. */
  deleteLegacyOperation(operationId: string): Promise<void>;
}

export class CoreSendTransactions implements SendTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  prepare(command: PrepareSendCommand): Promise<PreparedSendResult> {
    return this.runner.run((transaction) => transaction.sends.prepare(command));
  }

  updateLegacyState(operation: SendOperation): Promise<void> {
    return this.runner.run((transaction) => transaction.sends.updateLegacy(operation));
  }

  deleteLegacyOperation(operationId: string): Promise<void> {
    return this.runner.run((transaction) => transaction.sends.deleteLegacy(operationId));
  }
}
