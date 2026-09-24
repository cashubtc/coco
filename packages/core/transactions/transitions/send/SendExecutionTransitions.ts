import type { Token } from '@cashu/cashu-ts';
import { ProofValidationError, SendOperationConflictError } from '@core/models/Error.ts';
import type {
  ExecutingSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  RolledBackSendOperation,
} from '@core/operations/send/SendOperation.ts';
import type { CoreProof } from '@core/types.ts';
import type { CoreTransaction } from '../../CoreTransaction.ts';
import { trackTransactionWork } from '../../TransactionLifetime.ts';
import type {
  ApplySendResult,
  ApplySendResultInput,
  BeginSendExecutionInput,
  BeginSendExecutionResult,
  CancelPreparedSendInput,
  CancelPreparedSendResult,
  ExecuteExactSendInput,
  ExecuteExactSendResult,
  FailSendExecutionInput,
  FailSendExecutionResult,
} from './SendTransitionTypes.ts';
import {
  assertExactInputs,
  assertSwapResult,
  getIdempotentExactResult,
  normalizeMemo,
  sameCoreProofSet,
  sameToken,
} from './SendValidation.ts';

export function executeExactSend(
  tx: CoreTransaction,
  input: ExecuteExactSendInput,
): Promise<ExecuteExactSendResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
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

    const proofs = await getOwnedReadyInputs(tx, current);
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

    await tx.proofs.markInflight({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
    });
    const transitioned = await tx.sendOperations.transition({
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

    return { operation: pending, token, changed: true };
  });
}

export function beginSendExecution(
  tx: CoreTransaction,
  input: BeginSendExecutionInput,
): Promise<BeginSendExecutionResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
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

    const inputProofs = await getOwnedReadyInputs(tx, current);
    const revision = current.revision ?? 0;
    const executing: ExecutingSendOperation = {
      ...current,
      state: 'executing',
      revision: revision + 1,
      updatedAt: input.updatedAt,
      executionMemo: input.memo,
    };
    const transitioned = await tx.sendOperations.transition({
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

export function applySendResult(
  tx: CoreTransaction,
  input: ApplySendResultInput,
): Promise<ApplySendResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
    if (!current) {
      throw new SendOperationConflictError(input.operationId, 'Send operation not found');
    }
    if (current.state === 'pending') {
      if (
        !current.needsSwap ||
        !current.outputData ||
        !current.token ||
        !sameToken(current.token, input.token)
      ) {
        throw new SendOperationConflictError(
          input.operationId,
          'Send result conflicts with the persisted pending token',
        );
      }
      assertSwapResult(current, input);
      const persistedProofs = (
        await tx.proofs.getProofsByOperationId(current.mintUrl, current.id)
      ).filter((proof) => proof.createdByOperationId === current.id);
      if (!sameCoreProofSet(persistedProofs, [...input.keepProofs, ...input.sendProofs])) {
        throw new SendOperationConflictError(
          input.operationId,
          'Send result conflicts with the persisted pending proofs',
        );
      }
      return {
        operation: current,
        savedProofs: [],
        inflightProofSecrets: [],
        spentInputSecrets: [],
        changed: false,
      };
    }
    if (current.state !== 'executing' || !current.needsSwap || !current.outputData) {
      throw new SendOperationConflictError(
        input.operationId,
        `Cannot apply Send result in state ${current.state}`,
      );
    }
    const revision = current.revision ?? 0;
    assertSwapResult(current, input);
    const outputs = [...input.keepProofs, ...input.sendProofs];
    const existing = await tx.proofs.getProofsBySecrets(
      current.mintUrl,
      outputs.map((proof) => proof.secret),
    );
    const existingSecrets = new Set(existing.map((proof) => proof.secret));
    if (
      !sameCoreProofSet(
        existing,
        outputs.filter((proof) => existingSecrets.has(proof.secret)),
      )
    ) {
      throw new ProofValidationError(
        'Swap output already exists with conflicting proof data or ownership',
      );
    }
    // Old default recovery saved send outputs as ready. Remove those from the available balance
    // before publishing their pending token, without taking another operation's reservation.
    const sendSecrets = new Set(input.sendProofs.map((proof) => proof.secret));
    const inflightProofSecrets = existing
      .filter((proof) => sendSecrets.has(proof.secret) && proof.state === 'ready')
      .map((proof) => proof.secret);
    if (inflightProofSecrets.length > 0) {
      await tx.proofs.markInflight({
        mintUrl: current.mintUrl,
        unit: current.unit,
        operationId: current.id,
        secrets: inflightProofSecrets,
        ownership: 'created',
      });
    }
    // Preserve change reservations and spending, as well as already inflight or spent send outputs.
    const savedProofs = outputs.filter((proof) => !existingSecrets.has(proof.secret));
    await tx.proofs.settleSpend({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
      state: ['ready', 'spent'],
      outputs: savedProofs,
    });

    const pending: PendingSendOperation = {
      ...current,
      state: 'pending',
      revision: (current.revision ?? 0) + 1,
      updatedAt: input.updatedAt,
      token: input.token,
    };
    const transitioned = await tx.sendOperations.transition({
      operationId: current.id,
      expectedState: 'executing',
      expectedRevision: revision,
      next: pending,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Send result lost an executing-state conflict',
      );
    }

    return {
      operation: pending,
      savedProofs,
      inflightProofSecrets,
      spentInputSecrets: [...current.inputProofSecrets],
      changed: true,
    };
  });
}

export function failSendExecution(
  tx: CoreTransaction,
  input: FailSendExecutionInput,
): Promise<FailSendExecutionResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
    if (!current) {
      throw new SendOperationConflictError(input.operationId, 'Send operation not found');
    }
    if (current.state === 'rolled_back' && current.error === input.error) {
      return {
        operation: current,
        releasedInputSecrets: [],
        changed: false,
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
    await getOwnedReadyInputs(tx, current);
    await tx.proofs.releaseOwned(current.mintUrl, current.id, current.inputProofSecrets);
    const failed: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: (current.revision ?? 0) + 1,
      updatedAt: input.updatedAt,
      error: input.error,
    };
    const transitioned = await tx.sendOperations.transition({
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
      changed: true,
    };
  });
}

export function cancelPreparedSend(
  tx: CoreTransaction,
  input: CancelPreparedSendInput,
): Promise<CancelPreparedSendResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
    if (!current) {
      throw new SendOperationConflictError(input.operationId, 'Send operation not found');
    }
    if (current.state === 'rolled_back' && current.error === input.reason) {
      return { operation: current, releasedInputSecrets: [], changed: false };
    }
    if (current.state !== 'prepared') {
      throw new SendOperationConflictError(
        input.operationId,
        'Send cancellation lost a prepared-state or revision conflict',
      );
    }

    const revision = current.revision ?? 0;
    await getOwnedReadyInputs(tx, current);
    await tx.proofs.releaseOwned(current.mintUrl, current.id, current.inputProofSecrets);
    const rolledBack: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: revision + 1,
      updatedAt: input.updatedAt,
      error: input.reason,
    };
    const transitioned = await tx.sendOperations.transition({
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
      changed: true,
    };
  });
}

async function getOwnedReadyInputs(
  tx: CoreTransaction,
  operation: PreparedSendOperation | ExecutingSendOperation,
): Promise<CoreProof[]> {
  return tx.proofs.getOwned({
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    operationId: operation.id,
    secrets: operation.inputProofSecrets,
    state: 'ready',
  });
}
