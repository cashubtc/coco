import type { Token } from '@cashu/cashu-ts';
import { SendOperationConflictError, ProofValidationError } from '@core/models/Error.ts';
import type { ExecuteExactSendInput, ExecuteExactSendResult } from './types.ts';
import type { CoreTransaction } from '../CoreTransaction.ts';
import { trackTransactionWork } from '../TransactionLifetime.ts';
import { getIdempotentExactResult, assertExactInputs, normalizeMemo } from './validation.ts';
import { getOwnedReadyInputs } from './inputs.ts';

export function executeExactSend(
  transaction: CoreTransaction,
  input: ExecuteExactSendInput,
): Promise<ExecuteExactSendResult> {
  return trackTransactionWork(transaction, async () => {
    const current = await transaction.sendOperations.getById(input.operationId);
    const idempotent = getIdempotentExactResult(current, input);
    if (idempotent) return idempotent;

    if (!current || current.state !== 'prepared') {
      throw new SendOperationConflictError(
        input.operationId,
        'Exact Send execution lost a state or revision conflict',
      );
    }
    if (current.needsSwap || current.method !== 'default') {
      throw new ProofValidationError(`Send operation ${input.operationId} requires a mint swap`);
    }

    const proofs = await getOwnedReadyInputs(transaction, current);
    assertExactInputs(proofs, current);
    const revision = current.revision ?? 0;
    const normalizedMemo = normalizeMemo(input.memo);
    const token: Token = {
      mint: current.mintUrl,
      proofs,
      unit: current.unit,
      ...(normalizedMemo ? { memo: normalizedMemo } : {}),
    };
    const pending: ExecuteExactSendResult['operation'] = {
      ...current,
      state: 'pending',
      updatedAt: input.updatedAt,
      token,
    };

    await transaction.proofs.markInflight({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
    });
    const transitioned = await transaction.sendOperations.transition({
      operationId: current.id,
      expectedState: 'prepared',
      expectedRevision: revision,
      next: pending,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Exact Send execution lost a state or revision conflict',
      );
    }
    pending.revision = revision + 1;

    return { operation: pending, token, committed: true };
  });
}
