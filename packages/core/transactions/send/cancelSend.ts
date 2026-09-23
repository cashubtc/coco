import { SendOperationConflictError } from '@core/models/Error.ts';
import type { RolledBackSendOperation } from '@core/operations/send/SendOperation.ts';
import type {
  FailSwapExecutionInput,
  FailedSwapExecution,
  CancelPreparedSendInput,
  CancelledPreparedSend,
} from './types.ts';
import type { CoreTransaction } from '../CoreTransaction.ts';
import { trackTransactionWork } from '../TransactionLifetime.ts';
import { getOwnedReadyInputs } from './inputs.ts';

export function cancelPreparedSend(
  transaction: CoreTransaction,
  input: CancelPreparedSendInput,
): Promise<CancelledPreparedSend> {
  return trackTransactionWork(transaction, async () => {
    const current = await transaction.sendOperations.getById(input.operationId);
    if (!current) {
      throw new SendOperationConflictError(input.operationId, 'Send operation not found');
    }
    if (current.state === 'rolled_back' && current.error === input.reason) {
      return { operation: current, releasedInputSecrets: [], committed: false };
    }
    if (current.state !== 'prepared') {
      throw new SendOperationConflictError(
        input.operationId,
        'Send cancellation lost a prepared-state or revision conflict',
      );
    }

    const revision = current.revision ?? 0;
    await getOwnedReadyInputs(transaction, current);
    await transaction.proofs.releaseOwned(current.mintUrl, current.id, current.inputProofSecrets);
    const rolledBack: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: revision + 1,
      updatedAt: input.updatedAt,
      error: input.reason,
    };
    const transitioned = await transaction.sendOperations.transition({
      operationId: current.id,
      expectedState: 'prepared',
      expectedRevision: revision,
      next: rolledBack,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Send cancellation lost a prepared-state or revision conflict',
      );
    }

    return {
      operation: rolledBack,
      releasedInputSecrets: [...current.inputProofSecrets],
      committed: true,
    };
  });
}

export function failSendExecution(
  transaction: CoreTransaction,
  input: FailSwapExecutionInput,
): Promise<FailedSwapExecution> {
  return trackTransactionWork(transaction, async () => {
    const current = await transaction.sendOperations.getById(input.operationId);
    if (!current) {
      throw new SendOperationConflictError(input.operationId, 'Send operation not found');
    }
    if (current.state === 'rolled_back' && current.error === input.error) {
      return {
        operation: current,
        releasedInputSecrets: [],
        committed: false,
      };
    }
    if (current.state !== 'executing' || !current.needsSwap) {
      throw new SendOperationConflictError(
        input.operationId,
        `Cannot fail Send execution in state ${current.state}`,
      );
    }
    const revision = current.revision ?? 0;
    if (revision !== input.expectedRevision) {
      throw new SendOperationConflictError(
        input.operationId,
        'Send failure lost an executing revision conflict',
      );
    }
    await getOwnedReadyInputs(transaction, current);
    await transaction.proofs.releaseOwned(current.mintUrl, current.id, current.inputProofSecrets);
    const failed: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: (current.revision ?? 0) + 1,
      updatedAt: input.updatedAt,
      error: input.error,
    };
    const transitioned = await transaction.sendOperations.transition({
      operationId: current.id,
      expectedState: 'executing',
      expectedRevision: revision,
      next: failed,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Send failure lost an executing-state conflict',
      );
    }

    return {
      operation: failed,
      releasedInputSecrets: [...current.inputProofSecrets],
      committed: true,
    };
  });
}
