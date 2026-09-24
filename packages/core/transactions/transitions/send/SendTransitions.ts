import { Amount, sumProofs, type Token } from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError, SendOperationConflictError } from '@core/models/Error.ts';
import {
  getKeepProofSecrets,
  getSendProofSecrets,
  isLegacyTokenlessP2pkSend,
  isTerminalOperation,
  type ExecutingSendOperation,
  type FinalizedSendOperation,
  type PendingSendOperation,
  type PreparedSendOperation,
  type RolledBackSendOperation,
  type RollingBackSendOperation,
} from '@core/operations/send/SendOperation.ts';
import { assertOutputProofs } from '@core/proofs/OutputProofs.ts';
import type { CoreProof } from '@core/types.ts';
import type { CoreTransaction } from '../../CoreTransaction.ts';
import { trackTransactionWork } from '../../TransactionLifetime.ts';
import type {
  ApplySendResult,
  ApplySendResultInput,
  BeginSendExecutionInput,
  BeginSendExecutionResult,
  BeginSendReclaimInput,
  BeginSendReclaimResult,
  CancelPreparedSendInput,
  CancelPreparedSendResult,
  ClaimSendRecoveryInput,
  ClaimSendRecoveryResult,
  CleanupLegacySendInitResult,
  CleanupOrphanedSendReservationsResult,
  CompletePendingSendInput,
  CompletePendingSendResult,
  CompleteSendReclaimInput,
  CompleteSendReclaimResult,
  ExecuteExactSendInput,
  ExecuteExactSendResult,
  FailSendExecutionInput,
  FailSendExecutionResult,
  PrepareSendInput,
  PrepareSendResult,
  RecoverLegacyExactSendInput,
  RecoverLegacyExactSendResult,
} from './SendTransitionTypes.ts';
import {
  assertExactInputs,
  assertSwapResult,
  canCompleteWithInput,
  getIdempotentExactResult,
  normalizeMemo,
  sameCoreProofSet,
  sameProofSet,
  sameToken,
} from './SendValidation.ts';

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

export function claimSendRecovery(
  tx: CoreTransaction,
  input: ClaimSendRecoveryInput,
): Promise<ClaimSendRecoveryResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
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
    const inputProofs = await tx.proofs.getOwned({
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
    const transitioned = await tx.sendOperations.transition({
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

export function recoverLegacyExactSend(
  tx: CoreTransaction,
  input: RecoverLegacyExactSendInput,
): Promise<RecoverLegacyExactSendResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(input.operationId);
    // New exact Sends never enter executing. Legacy rows normalize their absent revision to zero.
    if (
      !current ||
      current.state !== 'executing' ||
      (current.revision ?? 0) !== 0 ||
      current.method !== 'default' ||
      current.needsSwap ||
      current.outputData ||
      ('token' in current && current.token)
    ) {
      throw new SendOperationConflictError(
        input.operationId,
        'Legacy exact Send recovery lost a state or revision conflict',
      );
    }
    const inputs = await tx.proofs.getOwned({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
      state: ['ready', 'inflight'],
    });
    assertExactInputs(inputs, current);
    // The old exact path returned a token only after persisting pending and never submitted inputs.
    await tx.proofs.releaseUnsubmitted({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
    });
    const operation: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: 1,
      updatedAt: input.updatedAt,
      error: 'Recovered legacy exact Send interrupted before token delivery',
    };
    if (
      !(await tx.sendOperations.transition({
        operationId: current.id,
        expectedState: 'executing',
        expectedRevision: 0,
        next: operation,
      }))
    ) {
      throw new SendOperationConflictError(current.id, 'Legacy exact Send recovery conflicted');
    }
    return {
      operation,
      readyProofSecrets: inputs
        .filter((proof) => proof.state === 'inflight')
        .map((proof) => proof.secret),
      releasedInputSecrets: [...current.inputProofSecrets],
      changed: true,
    };
  });
}

export function cleanupLegacySendInit(
  tx: CoreTransaction,
  operationId: string,
): Promise<CleanupLegacySendInitResult> {
  return trackTransactionWork(tx, async () => {
    const current = await tx.sendOperations.getById(operationId);
    if (!current || current.state !== 'init') {
      throw new SendOperationConflictError(operationId, 'Legacy Send init operation not found');
    }
    const operationProofs = await tx.proofs.getProofsByOperationId(current.mintUrl, current.id);
    const ownedSecrets = operationProofs
      .filter((proof) => proof.usedByOperationId === current.id)
      .map((proof) => proof.secret);
    if (ownedSecrets.length > 0) {
      await tx.proofs.releaseOwned(current.mintUrl, current.id, ownedSecrets);
    }
    await tx.sendOperations.delete(current.id);
    return {
      operationId: current.id,
      mintUrl: current.mintUrl,
      releasedProofSecrets: ownedSecrets,
    };
  });
}

export function cleanupOrphanedSendReservations(
  tx: CoreTransaction,
): Promise<CleanupOrphanedSendReservationsResult> {
  return trackTransactionWork(tx, async () => {
    const reservedProofs = await tx.proofs.getReservedProofs();
    const reservedByMint = new Map<string, CoreProof[]>();
    for (const proof of reservedProofs) {
      if (!proof.usedByOperationId) continue;
      const proofs = reservedByMint.get(proof.mintUrl) ?? [];
      proofs.push(proof);
      reservedByMint.set(proof.mintUrl, proofs);
    }

    const released: CleanupOrphanedSendReservationsResult['released'] = [];
    for (const [mintUrl, reserved] of reservedByMint) {
      const operations = await tx.sendOperations.getByMintUrl(mintUrl);
      const operationById = new Map(operations.map((operation) => [operation.id, operation]));
      const secrets = reserved
        .filter((proof) => {
          const operation = operationById.get(proof.usedByOperationId!);
          // A missing Send record does not establish ownership: Melt and future
          // workflows also reserve proofs. Only clean up known terminal Sends.
          return operation !== undefined && isTerminalOperation(operation);
        })
        .map((proof) => proof.secret);
      if (secrets.length > 0) released.push({ mintUrl, secrets });
    }
    for (const group of released) {
      const reserved = reservedByMint.get(group.mintUrl)!;
      const owners = new Set(
        reserved
          .filter((proof) => group.secrets.includes(proof.secret))
          .map((proof) => proof.usedByOperationId!),
      );
      for (const owner of owners) {
        await tx.proofs.releaseOwned(
          group.mintUrl,
          owner,
          reserved
            .filter(
              (proof) => proof.usedByOperationId === owner && group.secrets.includes(proof.secret),
            )
            .map((proof) => proof.secret),
        );
      }
    }
    return {
      released,
      count: released.reduce((count, group) => count + group.secrets.length, 0),
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
