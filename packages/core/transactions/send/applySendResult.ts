import { SendOperationConflictError, ProofValidationError } from '@core/models/Error.ts';
import type { PendingSendOperation } from '@core/operations/send/SendOperation.ts';
import type { ApplySwapResultInput, AppliedSwapResult } from './types.ts';
import type { CoreTransaction } from '../CoreTransaction.ts';
import { trackTransactionWork } from '../TransactionLifetime.ts';
import { assertSwapResult, sameToken, sameCoreProofSet } from './validation.ts';

export function applySendResult(
  transaction: CoreTransaction,
  input: ApplySwapResultInput,
): Promise<AppliedSwapResult> {
  return trackTransactionWork(transaction, async () => {
    const current = await transaction.sendOperations.getById(input.operationId);
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
        await transaction.proofs.getProofsByOperationId(current.mintUrl, current.id)
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
        committed: false,
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
    const existing = await transaction.proofs.getProofsBySecrets(
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
      await transaction.proofs.markInflight({
        mintUrl: current.mintUrl,
        unit: current.unit,
        operationId: current.id,
        secrets: inflightProofSecrets,
        ownership: 'created',
      });
    }
    // Preserve change reservations and spending, as well as already inflight or spent send outputs.
    const savedProofs = outputs.filter((proof) => !existingSecrets.has(proof.secret));
    await transaction.proofs.settleSpend({
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
    const transitioned = await transaction.sendOperations.transition({
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
      committed: true,
    };
  });
}
