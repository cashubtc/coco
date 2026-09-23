import { Amount, type Proof } from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { SendOperationConflictError, ProofValidationError } from '@core/models/Error.ts';
import {
  getSendProofSecrets,
  isLegacyTokenlessP2pkSend,
  type FinalizedSendOperation,
} from '@core/operations/send/SendOperation.ts';
import type { CompletePendingSendInput, CompletedPendingSend } from './types.ts';
import type { CoreTransaction } from '../CoreTransaction.ts';
import { trackTransactionWork } from '../TransactionLifetime.ts';
import { canCompleteWithInput, sameProofSet } from './validation.ts';

export function completePendingSend(
  transaction: CoreTransaction,
  input: CompletePendingSendInput,
): Promise<CompletedPendingSend> {
  return trackTransactionWork(transaction, async () => {
    const current = await transaction.sendOperations.getById(input.operationId);
    if (!current) {
      throw new SendOperationConflictError(input.operationId, 'Send operation not found');
    }
    if (current.state === 'finalized') {
      return {
        operation: current,
        spentProofSecrets: [],
        releasedInputSecrets: [],
        committed: false,
      };
    }
    if (current.state !== 'pending') {
      throw new SendOperationConflictError(
        input.operationId,
        'Send completion lost a pending-state or revision conflict',
      );
    }

    const revision = current.revision ?? 0;
    const expectedSecrets = getSendProofSecrets(current);
    if (expectedSecrets.length === 0 || new Set(expectedSecrets).size !== expectedSecrets.length) {
      throw new ProofValidationError(`Send operation ${current.id} has invalid send proof data`);
    }
    const observedSecrets = input.spentProofSecrets ?? [];
    if (new Set(observedSecrets).size !== observedSecrets.length) {
      throw new ProofValidationError('Send completion contains duplicate proof observations');
    }
    const expectedSet = new Set(expectedSecrets);
    for (const secret of observedSecrets) {
      if (!expectedSet.has(secret)) {
        throw new ProofValidationError(`Proof ${secret} does not belong to Send operation`);
      }
    }

    const legacyObservation = input.legacyP2pkOutputObservation;
    if (
      legacyObservation &&
      (!isLegacyTokenlessP2pkSend(current) ||
        legacyObservation.expectedRevision !== revision ||
        legacyObservation.mintUrl !== current.mintUrl ||
        legacyObservation.unit !== current.unit ||
        JSON.stringify(legacyObservation.outputData) !== JSON.stringify(current.outputData) ||
        observedSecrets.length !== expectedSecrets.length)
    ) {
      throw new ProofValidationError(
        'Cannot complete legacy P2PK Send: stale or incomplete observation',
      );
    }

    const sendProofs = await transaction.proofs.getProofsBySecrets(
      current.mintUrl,
      expectedSecrets,
    );
    const sendBySecret = new Map(sendProofs.map((proof) => [proof.secret, proof]));
    if (!legacyObservation && sendBySecret.size !== expectedSecrets.length) {
      throw new ProofValidationError('Cannot complete Send operation: missing send proof metadata');
    }
    if (
      !legacyObservation &&
      (!current.token ||
        current.token.mint !== current.mintUrl ||
        normalizeUnit(current.token.unit) !== normalizeUnit(current.unit) ||
        !sameProofSet(current.token.proofs, sendProofs))
    ) {
      throw new ProofValidationError('Send proofs do not match the persisted token');
    }
    for (const secret of expectedSecrets) {
      const proof = sendBySecret.get(secret);
      if (legacyObservation) {
        // Old restore omitted spent outputs. Validate any surviving rows without recreating them.
        if (!proof) continue;
        const output = legacyObservation.outputData.send[expectedSecrets.indexOf(secret)]!;
        if (
          proof.id !== output.blindedMessage.id ||
          !Amount.from(proof.amount).equals(Amount.from(output.blindedMessage.amount))
        ) {
          throw new ProofValidationError('Legacy P2PK proof does not match allocated output');
        }
      }
      const owned = current.needsSwap
        ? proof?.createdByOperationId === current.id
        : proof && canCompleteWithInput(proof, current.id);
      if (
        !proof ||
        !owned ||
        proof.mintUrl !== current.mintUrl ||
        normalizeUnit(proof.unit) !== normalizeUnit(current.unit) ||
        (proof.state !== 'inflight' && proof.state !== 'spent')
      ) {
        throw new ProofValidationError(`Send proof ${secret} is not inflight and operation-owned`);
      }
    }

    const newlySpent = observedSecrets.filter(
      (secret) => sendBySecret.get(secret)?.state === 'inflight',
    );
    if (newlySpent.length > 0) {
      await transaction.proofs.recordSpent({
        mintUrl: current.mintUrl,
        unit: current.unit,
        operationId: current.id,
        secrets: newlySpent,
        ownership: current.needsSwap ? 'created' : 'used',
      });
    }
    const allSpent = expectedSecrets.every(
      (secret) => observedSecrets.includes(secret) || sendBySecret.get(secret)?.state === 'spent',
    );
    if (!allSpent) {
      return {
        operation: current,
        spentProofSecrets: newlySpent,
        releasedInputSecrets: [],
        committed: newlySpent.length > 0,
      };
    }

    const inputs = await transaction.proofs.getProofsBySecrets(
      current.mintUrl,
      current.inputProofSecrets,
    );
    const inputBySecret = new Map(inputs.map((proof) => [proof.secret, proof]));
    if (inputBySecret.size !== current.inputProofSecrets.length) {
      throw new ProofValidationError(
        'Cannot complete Send operation: missing input proof metadata',
      );
    }
    for (const secret of current.inputProofSecrets) {
      const proof = inputBySecret.get(secret);
      if (
        !proof ||
        !canCompleteWithInput(proof, current.id) ||
        proof.mintUrl !== current.mintUrl ||
        normalizeUnit(proof.unit) !== normalizeUnit(current.unit) ||
        proof.state !== 'spent'
      ) {
        throw new ProofValidationError(`Send input ${secret} is not spent and operation-owned`);
      }
    }
    const releasedInputSecrets = inputs
      .filter((proof) => proof.usedByOperationId === current.id)
      .map((proof) => proof.secret);
    if (releasedInputSecrets.length > 0) {
      await transaction.proofs.releaseOwned(current.mintUrl, current.id, releasedInputSecrets);
    }

    const finalized: FinalizedSendOperation = {
      ...current,
      state: 'finalized',
      revision: revision + 1,
      updatedAt: input.updatedAt,
    };
    const transitioned = await transaction.sendOperations.transition({
      operationId: current.id,
      expectedState: 'pending',
      expectedRevision: revision,
      next: finalized,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Send completion lost a pending-state or revision conflict',
      );
    }

    return {
      operation: finalized,
      spentProofSecrets: newlySpent,
      releasedInputSecrets,
      committed: true,
    };
  });
}
