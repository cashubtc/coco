import { SendOperationConflictError } from '@core/models/Error.ts';
import type { ExecutingSendOperation } from '@core/operations/send/SendOperation.ts';
import type {
  BeginSwapExecutionInput,
  ClaimSendRecoveryInput,
  BegunSwapExecution,
} from './types.ts';
import type { CoreTransaction } from '../CoreTransaction.ts';
import { trackTransactionWork } from '../TransactionLifetime.ts';
import { getOwnedReadyInputs } from './inputs.ts';

export function beginSendExecution(
  transaction: CoreTransaction,
  input: BeginSwapExecutionInput,
): Promise<BegunSwapExecution> {
  return trackTransactionWork(transaction, async () => {
    const current = await transaction.sendOperations.getById(input.operationId);
    if (!current) {
      throw new SendOperationConflictError(input.operationId, 'Send operation not found');
    }
    if (current.state !== 'prepared') {
      throw new SendOperationConflictError(
        input.operationId,
        `Cannot begin Send execution in state ${current.state}`,
      );
    }
    if (!current.needsSwap || !current.outputData) {
      throw new SendOperationConflictError(
        input.operationId,
        'Swap execution requires a prepared swap request',
      );
    }

    const inputProofs = await getOwnedReadyInputs(transaction, current);
    const revision = current.revision ?? 0;
    const executing: ExecutingSendOperation = {
      ...current,
      state: 'executing',
      revision: revision + 1,
      updatedAt: input.updatedAt,
      executionMemo: input.memo,
    };
    const transitioned = await transaction.sendOperations.transition({
      operationId: current.id,
      expectedState: 'prepared',
      expectedRevision: revision,
      next: executing,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Send execution lost a prepared-state conflict',
      );
    }

    return {
      operation: executing,
      request: {
        mintUrl: executing.mintUrl,
        unit: executing.unit,
        amount: executing.amount,
        inputProofs,
        outputData: current.outputData,
      },
    };
  });
}

export function claimSendRecovery(
  transaction: CoreTransaction,
  input: ClaimSendRecoveryInput,
): Promise<BegunSwapExecution> {
  return trackTransactionWork(transaction, async () => {
    const current = await transaction.sendOperations.getById(input.operationId);
    if (
      !current ||
      current.state !== 'executing' ||
      !current.needsSwap ||
      !current.outputData ||
      (current.revision ?? 0) !== input.expectedRevision
    ) {
      throw new SendOperationConflictError(
        input.operationId,
        'Send recovery lost an executing-state or revision conflict',
      );
    }
    // Legacy handlers spent inputs before persisting pending. A recovery claim never releases them.
    const inputProofs = await transaction.proofs.getOwned({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
      state: ['ready', 'spent'],
    });
    const claimed: ExecutingSendOperation = {
      ...current,
      revision: input.expectedRevision + 1,
      updatedAt: input.updatedAt,
    };
    const transitioned = await transaction.sendOperations.transition({
      operationId: current.id,
      expectedState: 'executing',
      expectedRevision: input.expectedRevision,
      next: claimed,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Send recovery lost an executing-state or revision conflict',
      );
    }
    return {
      operation: claimed,
      request: {
        mintUrl: claimed.mintUrl,
        unit: claimed.unit,
        amount: claimed.amount,
        inputProofs,
        outputData: claimed.outputData!,
      },
    };
  });
}
