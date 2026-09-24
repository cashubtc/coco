import { Amount, sumProofs } from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError, SendOperationConflictError } from '@core/models/Error.ts';
import {
  getKeepProofSecrets,
  getSendProofSecrets,
  isLegacyTokenlessP2pkSend,
  type FinalizedSendOperation,
  type RolledBackSendOperation,
  type RollingBackSendOperation,
  type PreparedSendOperation,
} from '@core/operations/send/SendOperation.ts';
import { assertOutputProofs } from '@core/proofs/OutputProofs.ts';
import type { CoreTransaction } from '../../CoreTransaction.ts';
import { trackTransactionWork } from '../../TransactionLifetime.ts';
import type {
  BeginSendReclaimInput,
  BeginSendReclaimResult,
  CompletePendingSendInput,
  CompletePendingSendResult,
  CompleteSendReclaimInput,
  CompleteSendReclaimResult,
  PrepareSendInput,
  PrepareSendResult,
} from './SendTransitionTypes.ts';
import { canCompleteWithInput, sameProofSet } from './SendValidation.ts';

/** Reserve inputs and persist their output allocation and prepared Send together. */
export function prepareSend(
  tx: CoreTransaction,
  input: PrepareSendInput,
): Promise<PrepareSendResult> {
  return trackTransactionWork(tx, async () => {
    const operation = input.operation;
    const existing = await tx.sendOperations.getById(operation.id);
    if (existing) {
      throw new SendOperationConflictError(
        operation.id,
        `Send operation id ${operation.id} already exists`,
      );
    }

    await tx.mintMetadata.assertTrusted(operation.mintUrl);
    const selected = await tx.proofs.selectAndReserve({
      mintUrl: operation.mintUrl,
      unit: operation.unit,
      operationId: operation.id,
      amount: operation.amount,
      forceSwap: input.forceSwap,
    });
    const inputAmount = sumProofs(selected.proofs);
    const inputProofSecrets = selected.proofs.map((proof) => proof.secret);

    let outputData: PreparedSendOperation['outputData'];
    let counterUpdate: PrepareSendResult['counter'];
    if (selected.needsSwap) {
      const allocation = await tx.outputs.allocate({
        mintUrl: operation.mintUrl,
        unit: operation.unit,
        activeKeys: input.activeKeys,
        seed: input.seed,
        keepAmount: inputAmount.subtract(operation.amount.add(selected.fee)),
        sendAmount: operation.amount,
        fixedSendOutputs: input.fixedSendOutputs,
      });
      outputData = allocation.outputData;
      counterUpdate = allocation.counter;
    } else {
      await tx.outputs.assertActiveKeys(operation.mintUrl, operation.unit, input.activeKeys);
    }

    const prepared: PreparedSendOperation = {
      ...operation,
      state: 'prepared',
      revision: 0,
      updatedAt: operation.updatedAt,
      needsSwap: selected.needsSwap,
      fee: selected.fee,
      inputAmount,
      inputProofSecrets,
      outputData,
    };
    await tx.sendOperations.create(prepared);

    return {
      operation: prepared,
      reservation: {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        secrets: inputProofSecrets,
        amount: inputAmount,
        unit: operation.unit,
      },
      counter: counterUpdate,
    };
  });
}

export function completePendingSend(
  tx: CoreTransaction,
  input: CompletePendingSendInput,
): Promise<CompletePendingSendResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
    if (!current) {
      throw new SendOperationConflictError(input.operationId, 'Send operation not found');
    }
    if (current.state === 'finalized') {
      return {
        operation: current,
        spentProofSecrets: [],
        releasedInputSecrets: [],
        changed: false,
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

    const sendProofs = await tx.proofs.getProofsBySecrets(current.mintUrl, expectedSecrets);
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
      await tx.proofs.recordSpent({
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
        changed: newlySpent.length > 0,
      };
    }

    const inputs = await tx.proofs.getProofsBySecrets(current.mintUrl, current.inputProofSecrets);
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
      await tx.proofs.releaseOwned(current.mintUrl, current.id, releasedInputSecrets);
    }

    const finalized: FinalizedSendOperation = {
      ...current,
      state: 'finalized',
      revision: revision + 1,
      updatedAt: input.updatedAt,
    };
    const transitioned = await tx.sendOperations.transition({
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
      changed: true,
    };
  });
}

export function beginSendReclaim(
  tx: CoreTransaction,
  input: BeginSendReclaimInput,
): Promise<BeginSendReclaimResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
    if (!current || current.state !== 'pending' || current.method !== 'default') {
      throw new SendOperationConflictError(
        input.operationId,
        'Pending Send reclaim lost a state or revision conflict',
      );
    }
    const sendSecrets = getSendProofSecrets(current);
    const associated = await tx.proofs.getProofsByOperationId(current.mintUrl, current.id);
    const secrets = associated
      .filter((proof) => sendSecrets.includes(proof.secret) && proof.state === 'inflight')
      .map((proof) => proof.secret);
    const inputProofs = await tx.proofs.getOwned({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets,
      state: 'inflight',
      ownership: current.needsSwap ? 'created' : 'used',
    });
    const total = sumProofs(inputProofs);
    const fee = await tx.proofs.getFee(current.mintUrl, current.unit, inputProofs);
    const skippedForFees = inputProofs.length > 0 && total.lessThanOrEqual(fee);
    const allocation =
      inputProofs.length > 0 && !skippedForFees
        ? await tx.outputs.allocate({
            mintUrl: current.mintUrl,
            unit: current.unit,
            activeKeys: input.activeKeys,
            seed: input.seed,
            keepAmount: total.subtract(fee),
            sendAmount: Amount.zero(),
          })
        : undefined;
    const revision = current.revision ?? 0;
    const rollingBack: RollingBackSendOperation = {
      ...current,
      state: 'rolling_back',
      revision: revision + 1,
      updatedAt: input.updatedAt,
      // Keep the original Send request intact. Reclaim has a separate Output Allocation.
      reclaimData: allocation
        ? { inputProofSecrets: secrets, outputData: allocation.outputData }
        : undefined,
    };
    const transitioned = await tx.sendOperations.transition({
      operationId: current.id,
      expectedState: 'pending',
      expectedRevision: revision,
      next: rollingBack,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Pending Send reclaim lost a state or revision conflict',
      );
    }
    return { operation: rollingBack, inputProofs, counter: allocation?.counter, skippedForFees };
  });
}

export function completeSendReclaim(
  tx: CoreTransaction,
  input: CompleteSendReclaimInput,
): Promise<CompleteSendReclaimResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
    if (!current || current.state !== 'rolling_back') {
      throw new SendOperationConflictError(
        input.operationId,
        'Pending Send reclaim completion lost a state or revision conflict',
      );
    }
    const allocation = current.reclaimData;
    const spentProofSecrets = allocation?.inputProofSecrets ?? [];
    if (allocation) {
      assertOutputProofs({
        mintUrl: current.mintUrl,
        unit: current.unit,
        outputData: allocation.outputData,
        kind: 'keep',
        state: 'ready',
        proofs: input.proofs,
      });
      await tx.proofs.settleSpend({
        mintUrl: current.mintUrl,
        unit: current.unit,
        operationId: current.id,
        secrets: spentProofSecrets,
        state: ['inflight', 'spent'],
        ownership: current.needsSwap ? 'created' : 'used',
        outputs: input.proofs,
      });
    } else if (input.proofs.length > 0) {
      throw new ProofValidationError('Reclaimed proofs have no committed output plan');
    }
    const associated = await tx.proofs.getProofsByOperationId(current.mintUrl, current.id);
    const releaseCandidates = new Set([
      ...current.inputProofSecrets,
      ...getKeepProofSecrets(current),
    ]);
    const releasedProofSecrets = associated
      .filter(
        (proof) => proof.usedByOperationId === current.id && releaseCandidates.has(proof.secret),
      )
      .map((proof) => proof.secret);
    await tx.proofs.releaseOwned(current.mintUrl, current.id, releasedProofSecrets);
    const revision = current.revision ?? 0;
    const rolledBack: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: revision + 1,
      updatedAt: input.updatedAt,
      error: input.reason,
    };
    const transitioned = await tx.sendOperations.transition({
      operationId: current.id,
      expectedState: 'rolling_back',
      expectedRevision: revision,
      next: rolledBack,
    });
    if (!transitioned) {
      throw new SendOperationConflictError(
        current.id,
        'Pending Send reclaim completion lost a state or revision conflict',
      );
    }
    return {
      operation: rolledBack,
      savedProofs: input.proofs,
      spentProofSecrets,
      releasedProofSecrets,
    };
  });
}
