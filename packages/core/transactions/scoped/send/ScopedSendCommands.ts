import { Amount, sumProofs, type Proof, type Token } from '@cashu/cashu-ts';
import { assertOutputProofs } from '@core/proofs/OutputProofs.ts';
import { normalizeUnit } from '@core/amounts.ts';
import { SendOperationConflictError, ProofValidationError } from '@core/models/Error.ts';
import type {
  ExecutingSendOperation,
  FinalizedSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  RollingBackSendOperation,
  RolledBackSendOperation,
  SendOperation,
} from '@core/operations/send/SendOperation.ts';
import {
  getSendProofSecrets,
  getKeepProofSecrets,
  isTerminalOperation,
} from '@core/operations/send/SendOperation.ts';
import type { SendOperationRepository } from '@core/repositories';
import type { CoreProof } from '@core/types.ts';
import type { ScopedMintMetadataCommands } from '../mints/ScopedMintMetadataCommands.ts';
import type {
  PrepareSendInput,
  PreparedSendResult,
  ExecuteExactSendInput,
  ExecuteExactSendResult,
  BeginSwapExecutionInput,
  ClaimSendRecoveryInput,
  SwapTransportRequest,
  BegunSwapExecution,
  ApplySwapResultInput,
  AppliedSwapResult,
  FailSwapExecutionInput,
  FailedSwapExecution,
  CancelPreparedSendInput,
  CancelledPreparedSend,
  CompletePendingSendInput,
  CompletedPendingSend,
  CleanupLegacyInitResult,
  CleanupOrphanedSendReservationsResult,
  BeginReclaimInput,
  BegunReclaim,
  CompleteReclaimInput,
  CompletedReclaim,
} from '../../send/types.ts';
import type { ScopedProofCommands } from '../proofs/ScopedProofCommands.ts';
import type { ScopedOutputCommands } from '../outputs/ScopedOutputCommands.ts';

export interface ScopedSendCommands {
  prepare(input: PrepareSendInput): Promise<PreparedSendResult>;
  executeExact(input: ExecuteExactSendInput): Promise<ExecuteExactSendResult>;
  beginExecution(input: BeginSwapExecutionInput): Promise<BegunSwapExecution>;
  claimRecovery(input: ClaimSendRecoveryInput): Promise<BegunSwapExecution>;
  applyResult(input: ApplySwapResultInput): Promise<AppliedSwapResult>;
  failExecution(input: FailSwapExecutionInput): Promise<FailedSwapExecution>;
  cancelPrepared(input: CancelPreparedSendInput): Promise<CancelledPreparedSend>;
  completePending(input: CompletePendingSendInput): Promise<CompletedPendingSend>;
  cleanupOrphanedReservations(): Promise<CleanupOrphanedSendReservationsResult>;
  cleanupLegacyInit(operationId: string): Promise<CleanupLegacyInitResult>;
  beginReclaim(input: BeginReclaimInput): Promise<BegunReclaim>;
  completeReclaim(input: CompleteReclaimInput): Promise<CompletedReclaim>;
}

export class RepositorySendCommands implements ScopedSendCommands {
  constructor(
    private readonly sends: SendOperationRepository,
    private readonly proofs: ScopedProofCommands,
    private readonly outputs: ScopedOutputCommands,
    private readonly mints: Pick<ScopedMintMetadataCommands, 'assertTrusted'>,
  ) {}

  async prepare(input: PrepareSendInput): Promise<PreparedSendResult> {
    const operation = input.operation;
    const existing = await this.sends.getById(operation.id);
    if (existing) {
      throw new SendOperationConflictError(
        operation.id,
        `Send operation id ${operation.id} already exists`,
      );
    }

    await this.mints.assertTrusted(operation.mintUrl);
    const selected = await this.proofs.selectAndReserve({
      mintUrl: operation.mintUrl,
      unit: operation.unit,
      operationId: operation.id,
      amount: operation.amount,
      forceSwap: input.forceSwap,
    });
    const inputAmount = sumProofs(selected.proofs);
    const inputProofSecrets = selected.proofs.map((proof) => proof.secret);

    let outputData: PreparedSendOperation['outputData'];
    let counterUpdate: PreparedSendResult['counter'];
    if (selected.needsSwap) {
      const allocation = await this.outputs.allocate({
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
      await this.outputs.assertActiveKeys(operation.mintUrl, operation.unit, input.activeKeys);
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
    await this.sends.create(prepared);

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
  }

  async executeExact(input: ExecuteExactSendInput): Promise<ExecuteExactSendResult> {
    const current = await this.sends.getById(input.operationId);
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

    const proofs = await this.getOwnedReadyInputs(current);
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

    await this.proofs.markInflight({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
    });
    const transitioned = await this.sends.transition({
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
  }

  async beginExecution(input: BeginSwapExecutionInput): Promise<BegunSwapExecution> {
    const current = await this.sends.getById(input.operationId);
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

    const inputProofs = await this.getOwnedReadyInputs(current);
    const revision = current.revision ?? 0;
    const executing: ExecutingSendOperation = {
      ...current,
      state: 'executing',
      revision: revision + 1,
      updatedAt: input.updatedAt,
      executionMemo: input.memo,
    };
    const transitioned = await this.sends.transition({
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
  }

  async claimRecovery(input: ClaimSendRecoveryInput): Promise<BegunSwapExecution> {
    const current = await this.sends.getById(input.operationId);
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
    const inputProofs = await this.getOwnedReadyInputs(current);
    const claimed: ExecutingSendOperation = {
      ...current,
      revision: input.expectedRevision + 1,
      updatedAt: input.updatedAt,
    };
    const transitioned = await this.sends.transition({
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
  }

  async applyResult(input: ApplySwapResultInput): Promise<AppliedSwapResult> {
    const current = await this.sends.getById(input.operationId);
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
        await this.proofs.getProofsByOperationId(current.mintUrl, current.id)
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
    await this.getOwnedReadyInputs(current);
    assertSwapResult(current, input);
    const savedProofs = [...input.keepProofs, ...input.sendProofs];
    await this.proofs.settleSpend({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets: current.inputProofSecrets,
      state: 'ready',
      outputs: savedProofs,
    });

    const pending: PendingSendOperation = {
      ...current,
      state: 'pending',
      revision: (current.revision ?? 0) + 1,
      updatedAt: input.updatedAt,
      token: input.token,
    };
    const transitioned = await this.sends.transition({
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
      spentInputSecrets: [...current.inputProofSecrets],
      committed: true,
    };
  }

  async failExecution(input: FailSwapExecutionInput): Promise<FailedSwapExecution> {
    const current = await this.sends.getById(input.operationId);
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
    await this.getOwnedReadyInputs(current);
    await this.proofs.releaseOwned(current.mintUrl, current.id, current.inputProofSecrets);
    const failed: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: (current.revision ?? 0) + 1,
      updatedAt: input.updatedAt,
      error: input.error,
    };
    const transitioned = await this.sends.transition({
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
  }

  async cancelPrepared(input: CancelPreparedSendInput): Promise<CancelledPreparedSend> {
    const current = await this.sends.getById(input.operationId);
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
    await this.getOwnedReadyInputs(current);
    await this.proofs.releaseOwned(current.mintUrl, current.id, current.inputProofSecrets);
    const rolledBack: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: revision + 1,
      updatedAt: input.updatedAt,
      error: input.reason,
    };
    const transitioned = await this.sends.transition({
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
  }

  async completePending(input: CompletePendingSendInput): Promise<CompletedPendingSend> {
    const current = await this.sends.getById(input.operationId);
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

    const sendProofs = await this.proofs.getProofsBySecrets(current.mintUrl, expectedSecrets);
    const sendBySecret = new Map(sendProofs.map((proof) => [proof.secret, proof]));
    if (sendBySecret.size !== expectedSecrets.length) {
      throw new ProofValidationError('Cannot complete Send operation: missing send proof metadata');
    }
    for (const secret of expectedSecrets) {
      const proof = sendBySecret.get(secret);
      const owned = current.needsSwap
        ? proof?.createdByOperationId === current.id
        : proof?.usedByOperationId === current.id;
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
      (secret) => sendBySecret.get(secret)?.state !== 'spent',
    );
    if (newlySpent.length > 0) {
      await this.proofs.recordSpent({
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

    const inputs = await this.proofs.getProofsBySecrets(current.mintUrl, current.inputProofSecrets);
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
        proof.usedByOperationId !== current.id ||
        proof.mintUrl !== current.mintUrl ||
        normalizeUnit(proof.unit) !== normalizeUnit(current.unit) ||
        proof.state !== 'spent'
      ) {
        throw new ProofValidationError(`Send input ${secret} is not spent and operation-owned`);
      }
    }
    await this.proofs.releaseOwned(current.mintUrl, current.id, current.inputProofSecrets);

    const finalized: FinalizedSendOperation = {
      ...current,
      state: 'finalized',
      revision: revision + 1,
      updatedAt: input.updatedAt,
    };
    const transitioned = await this.sends.transition({
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
      releasedInputSecrets: [...current.inputProofSecrets],
      committed: true,
    };
  }

  async cleanupLegacyInit(operationId: string): Promise<CleanupLegacyInitResult> {
    const current = await this.sends.getById(operationId);
    if (!current || current.state !== 'init') {
      throw new SendOperationConflictError(operationId, 'Legacy Send init operation not found');
    }
    const operationProofs = await this.proofs.getProofsByOperationId(current.mintUrl, current.id);
    const ownedSecrets = operationProofs
      .filter((proof) => proof.usedByOperationId === current.id)
      .map((proof) => proof.secret);
    if (ownedSecrets.length > 0) {
      await this.proofs.releaseOwned(current.mintUrl, current.id, ownedSecrets);
    }
    await this.sends.delete(current.id);
    return {
      operationId: current.id,
      mintUrl: current.mintUrl,
      releasedProofSecrets: ownedSecrets,
    };
  }

  async cleanupOrphanedReservations(): Promise<CleanupOrphanedSendReservationsResult> {
    const reservedProofs = await this.proofs.getReservedProofs();
    const reservedByMint = new Map<string, CoreProof[]>();
    for (const proof of reservedProofs) {
      if (!proof.usedByOperationId) continue;
      const proofs = reservedByMint.get(proof.mintUrl) ?? [];
      proofs.push(proof);
      reservedByMint.set(proof.mintUrl, proofs);
    }

    const released: CleanupOrphanedSendReservationsResult['released'] = [];
    for (const [mintUrl, reserved] of reservedByMint) {
      const operations = await this.sends.getByMintUrl(mintUrl);
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
        await this.proofs.releaseOwned(
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
  }

  async beginReclaim(input: BeginReclaimInput): Promise<BegunReclaim> {
    const current = await this.sends.getById(input.operationId);
    if (!current || current.state !== 'pending' || current.method !== 'default') {
      throw new SendOperationConflictError(
        input.operationId,
        'Pending Send reclaim lost a state or revision conflict',
      );
    }
    const sendSecrets = getSendProofSecrets(current);
    const associated = await this.proofs.getProofsByOperationId(current.mintUrl, current.id);
    const secrets = associated
      .filter((proof) => sendSecrets.includes(proof.secret) && proof.state === 'inflight')
      .map((proof) => proof.secret);
    const inputProofs = await this.proofs.getOwned({
      mintUrl: current.mintUrl,
      unit: current.unit,
      operationId: current.id,
      secrets,
      state: 'inflight',
      ownership: current.needsSwap ? 'created' : 'used',
    });
    const total = sumProofs(inputProofs);
    const fee = await this.proofs.getFee(current.mintUrl, current.unit, inputProofs);
    const skippedForFees = inputProofs.length > 0 && total.lessThanOrEqual(fee);
    const allocation =
      inputProofs.length > 0 && !skippedForFees
        ? await this.outputs.allocate({
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
    const transitioned = await this.sends.transition({
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
  }

  async completeReclaim(input: CompleteReclaimInput): Promise<CompletedReclaim> {
    const current = await this.sends.getById(input.operationId);
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
      await this.proofs.settleSpend({
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
    const associated = await this.proofs.getProofsByOperationId(current.mintUrl, current.id);
    const releaseCandidates = new Set([
      ...current.inputProofSecrets,
      ...getKeepProofSecrets(current),
    ]);
    const releasedProofSecrets = associated
      .filter(
        (proof) => proof.usedByOperationId === current.id && releaseCandidates.has(proof.secret),
      )
      .map((proof) => proof.secret);
    await this.proofs.releaseOwned(current.mintUrl, current.id, releasedProofSecrets);
    const revision = current.revision ?? 0;
    const rolledBack: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: revision + 1,
      updatedAt: input.updatedAt,
      error: input.reason,
    };
    const transitioned = await this.sends.transition({
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
  }

  private async getOwnedReadyInputs(
    operation: PreparedSendOperation | ExecutingSendOperation,
  ): Promise<CoreProof[]> {
    return this.proofs.getOwned({
      mintUrl: operation.mintUrl,
      unit: operation.unit,
      operationId: operation.id,
      secrets: operation.inputProofSecrets,
      state: 'ready',
    });
  }
}

function getIdempotentExactResult(
  current: SendOperation | null,
  input: ExecuteExactSendInput,
): ExecuteExactSendResult | undefined {
  if (!current || current.state !== 'pending' || current.needsSwap || !current.token) {
    return undefined;
  }
  if (!isEquivalentExactToken(current, current.token, input)) {
    throw new SendOperationConflictError(
      input.operationId,
      'Exact Send result differs from the already committed operation',
    );
  }
  return {
    operation: current as ExecuteExactSendResult['operation'],
    token: current.token,
    committed: false,
  };
}

function isEquivalentExactToken(
  operation: PendingSendOperation,
  token: Token,
  input: ExecuteExactSendInput,
): boolean {
  return (
    token.mint === operation.mintUrl &&
    normalizeUnit(token.unit) === normalizeUnit(operation.unit) &&
    normalizeMemo(token.memo) === normalizeMemo(input.memo) &&
    token.proofs.length === operation.inputProofSecrets.length &&
    token.proofs.every((proof, index) => proof.secret === operation.inputProofSecrets[index])
  );
}

function assertExactInputs(resolved: Proof[], operation: PreparedSendOperation): void {
  if (
    !sumProofs(resolved).equals(operation.amount) ||
    !operation.inputAmount.equals(operation.amount) ||
    !operation.fee.isZero()
  ) {
    throw new ProofValidationError(`Send operation ${operation.id} is not an exact proof match`);
  }
}

function normalizeMemo(memo: string | undefined): string | undefined {
  const trimmed = memo?.trim();
  return trimmed ? trimmed : undefined;
}

function assertSwapResult(
  operation: ExecutingSendOperation | PendingSendOperation,
  input: ApplySwapResultInput,
): void {
  assertOutputProofs({
    ...operation,
    outputData: operation.outputData!,
    createdByOperationId: operation.id,
    proofs: input.keepProofs,
    state: 'ready',
    kind: 'keep',
  });
  assertOutputProofs({
    ...operation,
    outputData: operation.outputData!,
    createdByOperationId: operation.id,
    proofs: input.sendProofs,
    state: 'inflight',
    kind: 'send',
  });

  if (
    input.token.mint !== operation.mintUrl ||
    normalizeUnit(input.token.unit) !== normalizeUnit(operation.unit) ||
    input.token.memo !== operation.executionMemo ||
    !sameProofSet(input.token.proofs, input.sendProofs)
  ) {
    throw new ProofValidationError('Swap token does not match the persisted Send request');
  }
}

function sameToken(left: Token, right: Token): boolean {
  return (
    left.mint === right.mint &&
    normalizeUnit(left.unit) === normalizeUnit(right.unit) &&
    left.memo === right.memo &&
    sameProofSet(left.proofs, right.proofs)
  );
}

function sameCoreProofSet(left: CoreProof[], right: CoreProof[]): boolean {
  return (
    sameProofSet(left, right) &&
    left.every((proof) => {
      const candidate = right.find((item) => item.secret === proof.secret);
      return (
        candidate?.mintUrl === proof.mintUrl &&
        normalizeUnit(candidate.unit) === normalizeUnit(proof.unit) &&
        candidate.createdByOperationId === proof.createdByOperationId
      );
    })
  );
}

function sameProofSet(left: Proof[], right: Proof[]): boolean {
  if (
    left.length !== right.length ||
    new Set(left.map((proof) => proof.secret)).size !== left.length ||
    new Set(right.map((proof) => proof.secret)).size !== right.length
  ) {
    return false;
  }
  const rightBySecret = new Map(right.map((proof) => [proof.secret, proof]));
  return left.every((proof) => {
    const candidate = rightBySecret.get(proof.secret);
    return candidate ? sameProof(proof, candidate) : false;
  });
}

function sameProof(left: Proof, right: Proof): boolean {
  return (
    left.id === right.id &&
    left.secret === right.secret &&
    left.C === right.C &&
    Amount.from(left.amount).equals(Amount.from(right.amount)) &&
    left.witness === right.witness &&
    JSON.stringify(left.dleq) === JSON.stringify(right.dleq)
  );
}
