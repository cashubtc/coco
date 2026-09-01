import {
  Amount,
  KeyChain,
  OutputData,
  selectProofsRGLI,
  sumProofs,
  type KeyChainCache,
  type MintKeys,
  type OutputDataCreator,
  type OutputDataLike,
  type Proof,
  type SelectProofs,
  type Token,
} from '@cashu/cashu-ts';
import { assertSameUnit, normalizeUnit } from '@core/amounts.ts';
import { SendOperationConflictError, ProofValidationError } from '@core/models/Error.ts';
import type {
  ExecutingSendOperation,
  FinalizedSendOperation,
  InitSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  RollingBackSendOperation,
  RolledBackSendOperation,
  SendOperation,
} from '@core/operations/send/SendOperation.ts';
import { getSendProofSecrets, isTerminalOperation } from '@core/operations/send/SendOperation.ts';
import type {
  CounterRepository,
  KeysetRepository,
  ProofRepository,
  SendOperationRepository,
} from '@core/repositories';
import type { CoreProof } from '@core/types.ts';
import {
  getSecretsFromSerializedOutputData,
  serializeOutputData,
  type SerializedOutputData,
} from '@core/utils.ts';

export interface PrepareSendCommand {
  operation: InitSendOperation;
  /** Active keys and seed loaded before entering the transaction. */
  activeKeys: MintKeys;
  seed: Uint8Array;
  /** P2PK outputs are randomized once during preflight and fixed across transaction retries. */
  p2pkSendOutputs?: readonly OutputDataLike[];
}

export interface PreparedSendResult {
  operation: PreparedSendOperation;
  reservation: {
    mintUrl: string;
    operationId: string;
    secrets: string[];
    amount: Amount;
    unit: string;
  };
  counter?: { mintUrl: string; keysetId: string; counter: number };
}

export interface ExecuteExactSendCommand {
  operationId: string;
  updatedAt: number;
  memo?: string;
}

export interface ExecuteExactSendResult {
  operation: PendingSendOperation & { token: Token };
  token: Token;
  /** False when an equivalent pending result had already committed. */
  committed: boolean;
}

export interface BeginSwapExecutionCommand {
  operationId: string;
  updatedAt: number;
  /** Normalized before entering the retried transaction. */
  memo?: string;
}

export interface SwapTransportRequest {
  mintUrl: string;
  unit: string;
  amount: Amount;
  inputProofs: Proof[];
  outputData: SerializedOutputData;
}

export interface BegunSwapExecution {
  operation: ExecutingSendOperation;
  request: SwapTransportRequest;
}

export interface ApplySwapResultCommand {
  operationId: string;
  updatedAt: number;
  keepProofs: CoreProof[];
  sendProofs: CoreProof[];
  token: Token;
}

export interface AppliedSwapResult {
  operation: PendingSendOperation;
  savedProofs: CoreProof[];
  spentInputSecrets: string[];
  /** False when an equivalent result had already committed. */
  committed: boolean;
}

export interface FailSwapExecutionCommand {
  operationId: string;
  updatedAt: number;
  error: string;
}

export interface FailedSwapExecution {
  operation: RolledBackSendOperation;
  releasedInputSecrets: string[];
  /** False when the same terminal failure had already committed. */
  committed: boolean;
}

export interface CancelPreparedSendCommand {
  operationId: string;
  updatedAt: number;
  reason: string;
}

export interface CancelledPreparedSend {
  operation: RolledBackSendOperation;
  releasedInputSecrets: string[];
  /** False when the same cancellation had already committed. */
  committed: boolean;
}

export interface CompletePendingSendCommand {
  operationId: string;
  updatedAt: number;
  /** Proof-state observations made outside the transaction. */
  spentProofSecrets?: string[];
}

export interface CompletedPendingSend {
  operation: PendingSendOperation | FinalizedSendOperation;
  spentProofSecrets: string[];
  releasedInputSecrets: string[];
  /** True only when this call performed a proof or operation state change. */
  committed: boolean;
}

export interface CleanupLegacyInitResult {
  operationId: string;
  mintUrl: string;
  releasedProofSecrets: string[];
}

export interface CleanupOrphanedSendReservationsResult {
  released: Array<{ mintUrl: string; secrets: string[] }>;
  count: number;
}

/** Compatibility-only seam for the existing pending default-token reclaim flow. */
export interface BeginLegacyPendingRollbackCommand {
  operationId: string;
  updatedAt: number;
}

export interface CompleteLegacyPendingRollbackCommand {
  operationId: string;
  updatedAt: number;
  reason: string;
}

export interface TransactionalSendOperations {
  prepare(command: PrepareSendCommand): Promise<PreparedSendResult>;
  executeExact(command: ExecuteExactSendCommand): Promise<ExecuteExactSendResult>;
  beginExecution(command: BeginSwapExecutionCommand): Promise<BegunSwapExecution>;
  applyResult(command: ApplySwapResultCommand): Promise<AppliedSwapResult>;
  failExecution(command: FailSwapExecutionCommand): Promise<FailedSwapExecution>;
  cancelPrepared(command: CancelPreparedSendCommand): Promise<CancelledPreparedSend>;
  completePending(command: CompletePendingSendCommand): Promise<CompletedPendingSend>;
  cleanupOrphanedReservations(): Promise<CleanupOrphanedSendReservationsResult>;
  cleanupLegacyInit(operationId: string): Promise<CleanupLegacyInitResult>;
  beginLegacyPendingRollback(
    command: BeginLegacyPendingRollbackCommand,
  ): Promise<RollingBackSendOperation>;
  completeLegacyPendingRollback(
    command: CompleteLegacyPendingRollbackCommand,
  ): Promise<RolledBackSendOperation>;
}

export class RepositoryTransactionalSendOperations implements TransactionalSendOperations {
  constructor(
    private readonly proofs: ProofRepository,
    private readonly counters: CounterRepository,
    private readonly keysets: KeysetRepository,
    private readonly sends: SendOperationRepository,
    private readonly outputDataCreator: OutputDataCreator = OutputData,
    private readonly selectProofs: SelectProofs = selectProofsRGLI,
  ) {}

  async prepare(command: PrepareSendCommand): Promise<PreparedSendResult> {
    const operation = command.operation;
    const existing = await this.sends.getById(operation.id);
    if (existing) {
      throw new SendOperationConflictError(
        operation.id,
        `Send operation id ${operation.id} already exists`,
      );
    }

    const available = await this.proofs.getAvailableProofs(operation.mintUrl, {
      unit: operation.unit,
    });
    const keysets = await this.keysets.getKeysetsByMintUrl(operation.mintUrl);
    assertCurrentActiveKeys(operation, command.activeKeys, keysets);
    const keyChain = KeyChain.fromCache(operation.mintUrl, operation.unit, {
      mintUrl: operation.mintUrl,
      keysets: keysets.map((keyset) => ({
        id: keyset.id,
        unit: keyset.unit,
        active: keyset.active,
        input_fee_ppk: keyset.feePpk,
        keys: keyset.keypairs,
      })),
    } satisfies KeyChainCache);
    const selected = selectInputs(operation, available, keyChain, this.selectProofs);
    const inputAmount = sumProofs(selected.proofs);
    const inputProofSecrets = selected.proofs.map((proof) => proof.secret);

    let outputData: PreparedSendOperation['outputData'];
    let counterUpdate: PreparedSendResult['counter'];
    if (selected.needsSwap) {
      const currentCounter =
        (await this.counters.getCounter(operation.mintUrl, command.activeKeys.id))?.counter ?? 0;
      const keepAmount = inputAmount.subtract(operation.amount.add(selected.fee));
      const keep = keepAmount.isZero()
        ? []
        : this.outputDataCreator.createDeterministicData(
            keepAmount,
            command.seed,
            currentCounter,
            command.activeKeys,
          );
      const send =
        operation.method === 'p2pk'
          ? [...(command.p2pkSendOutputs ?? [])]
          : this.outputDataCreator.createDeterministicData(
              operation.amount,
              command.seed,
              currentCounter + keep.length,
              command.activeKeys,
            );
      if (operation.method === 'p2pk' && send.length === 0) {
        throw new ProofValidationError('P2PK Send preflight did not produce output data');
      }
      const allocatedPositions = keep.length + (operation.method === 'default' ? send.length : 0);
      if (allocatedPositions > 0) {
        const counter = currentCounter + allocatedPositions;
        await this.counters.setCounter(operation.mintUrl, command.activeKeys.id, counter);
        counterUpdate = { mintUrl: operation.mintUrl, keysetId: command.activeKeys.id, counter };
      }
      outputData = serializeOutputData({ keep, send });
    }

    await this.proofs.reserveProofs(operation.mintUrl, inputProofSecrets, operation.id);

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

  async executeExact(command: ExecuteExactSendCommand): Promise<ExecuteExactSendResult> {
    const current = await this.sends.getById(command.operationId);
    const idempotent = getIdempotentExactResult(current, command);
    if (idempotent) return idempotent;

    if (!current || current.state !== 'prepared') {
      throw new SendOperationConflictError(
        command.operationId,
        'Exact Send execution lost a state or revision conflict',
      );
    }
    if (current.needsSwap || current.method !== 'default') {
      throw new ProofValidationError(`Send operation ${command.operationId} requires a mint swap`);
    }

    const proofs = await loadOwnedReadyProofs(this.proofs, current);
    const revision = current.revision ?? 0;
    const normalizedMemo = normalizeMemo(command.memo);
    const token: Token = {
      mint: current.mintUrl,
      proofs,
      unit: current.unit,
      ...(normalizedMemo ? { memo: normalizedMemo } : {}),
    };
    const pending: ExecuteExactSendResult['operation'] = {
      ...current,
      state: 'pending',
      updatedAt: command.updatedAt,
      token,
    };

    await this.proofs.setProofState(current.mintUrl, current.inputProofSecrets, 'inflight');
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

  async beginExecution(command: BeginSwapExecutionCommand): Promise<BegunSwapExecution> {
    const current = await this.sends.getById(command.operationId);
    if (!current) {
      throw new SendOperationConflictError(command.operationId, 'Send operation not found');
    }
    if (current.state !== 'prepared') {
      throw new SendOperationConflictError(
        command.operationId,
        `Cannot begin Send execution in state ${current.state}`,
      );
    }
    if (!current.needsSwap || !current.outputData) {
      throw new SendOperationConflictError(
        command.operationId,
        'Swap execution requires a prepared swap request',
      );
    }

    const inputProofs = await this.getOwnedReadyInputs(current);
    const revision = current.revision ?? 0;
    const executing: ExecutingSendOperation = {
      ...current,
      state: 'executing',
      revision: revision + 1,
      updatedAt: command.updatedAt,
      executionMemo: command.memo,
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

  async applyResult(command: ApplySwapResultCommand): Promise<AppliedSwapResult> {
    const current = await this.sends.getById(command.operationId);
    if (!current) {
      throw new SendOperationConflictError(command.operationId, 'Send operation not found');
    }
    if (current.state === 'pending') {
      if (
        !current.needsSwap ||
        !current.outputData ||
        !current.token ||
        !sameToken(current.token, command.token)
      ) {
        throw new SendOperationConflictError(
          command.operationId,
          'Send result conflicts with the persisted pending token',
        );
      }
      assertSwapResult(current, command);
      const persistedProofs = (
        await this.proofs.getProofsByOperationId(current.mintUrl, current.id)
      ).filter((proof) => proof.createdByOperationId === current.id);
      if (!sameCoreProofSet(persistedProofs, [...command.keepProofs, ...command.sendProofs])) {
        throw new SendOperationConflictError(
          command.operationId,
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
        command.operationId,
        `Cannot apply Send result in state ${current.state}`,
      );
    }
    const revision = current.revision ?? 0;
    await this.getOwnedReadyInputs(current);
    assertSwapResult(current, command);
    const savedProofs = [...command.keepProofs, ...command.sendProofs];
    if (savedProofs.length > 0) {
      await this.proofs.saveProofs(current.mintUrl, savedProofs);
    }
    await this.proofs.setProofState(current.mintUrl, current.inputProofSecrets, 'spent');

    const pending: PendingSendOperation = {
      ...current,
      state: 'pending',
      revision: (current.revision ?? 0) + 1,
      updatedAt: command.updatedAt,
      token: command.token,
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

  async failExecution(command: FailSwapExecutionCommand): Promise<FailedSwapExecution> {
    const current = await this.sends.getById(command.operationId);
    if (!current) {
      throw new SendOperationConflictError(command.operationId, 'Send operation not found');
    }
    if (current.state === 'rolled_back' && current.error === command.error) {
      return {
        operation: current,
        releasedInputSecrets: [],
        committed: false,
      };
    }
    if (current.state !== 'executing' || !current.needsSwap) {
      throw new SendOperationConflictError(
        command.operationId,
        `Cannot fail Send execution in state ${current.state}`,
      );
    }
    const revision = current.revision ?? 0;
    await this.getOwnedReadyInputs(current);
    await this.proofs.releaseProofs(current.mintUrl, current.inputProofSecrets);
    const failed: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: (current.revision ?? 0) + 1,
      updatedAt: command.updatedAt,
      error: command.error,
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

  async cancelPrepared(command: CancelPreparedSendCommand): Promise<CancelledPreparedSend> {
    const current = await this.sends.getById(command.operationId);
    if (!current) {
      throw new SendOperationConflictError(command.operationId, 'Send operation not found');
    }
    if (current.state === 'rolled_back' && current.error === command.reason) {
      return { operation: current, releasedInputSecrets: [], committed: false };
    }
    if (current.state !== 'prepared') {
      throw new SendOperationConflictError(
        command.operationId,
        'Send cancellation lost a prepared-state or revision conflict',
      );
    }

    const revision = current.revision ?? 0;
    await this.getOwnedReadyInputs(current);
    await this.proofs.releaseProofs(current.mintUrl, current.inputProofSecrets);
    const rolledBack: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: revision + 1,
      updatedAt: command.updatedAt,
      error: command.reason,
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

  async completePending(command: CompletePendingSendCommand): Promise<CompletedPendingSend> {
    const current = await this.sends.getById(command.operationId);
    if (!current) {
      throw new SendOperationConflictError(command.operationId, 'Send operation not found');
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
        command.operationId,
        'Send completion lost a pending-state or revision conflict',
      );
    }

    const revision = current.revision ?? 0;
    const expectedSecrets = getSendProofSecrets(current);
    if (expectedSecrets.length === 0 || new Set(expectedSecrets).size !== expectedSecrets.length) {
      throw new ProofValidationError(`Send operation ${current.id} has invalid send proof data`);
    }
    const observedSecrets = command.spentProofSecrets ?? [];
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
      await this.proofs.setProofState(current.mintUrl, newlySpent, 'spent');
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
    await this.proofs.releaseProofs(current.mintUrl, current.inputProofSecrets);

    const finalized: FinalizedSendOperation = {
      ...current,
      state: 'finalized',
      revision: revision + 1,
      updatedAt: command.updatedAt,
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
      await this.proofs.releaseProofs(current.mintUrl, ownedSecrets);
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
          return !operation || isTerminalOperation(operation);
        })
        .map((proof) => proof.secret);
      if (secrets.length > 0) released.push({ mintUrl, secrets });
    }
    for (const group of released) {
      await this.proofs.releaseProofs(group.mintUrl, group.secrets);
    }
    return {
      released,
      count: released.reduce((count, group) => count + group.secrets.length, 0),
    };
  }

  async beginLegacyPendingRollback(
    command: BeginLegacyPendingRollbackCommand,
  ): Promise<RollingBackSendOperation> {
    const current = await this.sends.getById(command.operationId);
    if (!current || current.state !== 'pending' || current.method !== 'default') {
      throw new SendOperationConflictError(
        command.operationId,
        'Legacy pending Send rollback lost a state or revision conflict',
      );
    }
    const revision = current.revision ?? 0;
    const rollingBack: RollingBackSendOperation = {
      ...current,
      state: 'rolling_back',
      revision: revision + 1,
      updatedAt: command.updatedAt,
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
        'Legacy pending Send rollback lost a state or revision conflict',
      );
    }
    return rollingBack;
  }

  async completeLegacyPendingRollback(
    command: CompleteLegacyPendingRollbackCommand,
  ): Promise<RolledBackSendOperation> {
    const current = await this.sends.getById(command.operationId);
    if (!current || current.state !== 'rolling_back') {
      throw new SendOperationConflictError(
        command.operationId,
        'Legacy pending Send rollback completion lost a state or revision conflict',
      );
    }
    const revision = current.revision ?? 0;
    const rolledBack: RolledBackSendOperation = {
      ...current,
      state: 'rolled_back',
      revision: revision + 1,
      updatedAt: command.updatedAt,
      error: command.reason,
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
        'Legacy pending Send rollback completion lost a state or revision conflict',
      );
    }
    return rolledBack;
  }

  private async getOwnedReadyInputs(
    operation: PreparedSendOperation | ExecutingSendOperation,
  ): Promise<CoreProof[]> {
    const proofs = await this.proofs.getProofsBySecrets(
      operation.mintUrl,
      operation.inputProofSecrets,
    );
    const bySecret = new Map(proofs.map((proof) => [proof.secret, proof]));
    if (bySecret.size !== operation.inputProofSecrets.length) {
      throw new ProofValidationError('Could not find all reserved Send proofs');
    }
    return operation.inputProofSecrets.map((secret) => {
      const proof = bySecret.get(secret);
      if (
        !proof ||
        proof.state !== 'ready' ||
        proof.usedByOperationId !== operation.id ||
        proof.mintUrl !== operation.mintUrl ||
        normalizeUnit(proof.unit) !== normalizeUnit(operation.unit)
      ) {
        throw new ProofValidationError(`Send proof ${secret} is not ready and owned by operation`);
      }
      return proof;
    });
  }
}

function getIdempotentExactResult(
  current: SendOperation | null,
  command: ExecuteExactSendCommand,
): ExecuteExactSendResult | undefined {
  if (!current || current.state !== 'pending' || current.needsSwap || !current.token) {
    return undefined;
  }
  if (!isEquivalentExactToken(current, current.token, command)) {
    throw new SendOperationConflictError(
      command.operationId,
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
  command: ExecuteExactSendCommand,
): boolean {
  return (
    token.mint === operation.mintUrl &&
    normalizeUnit(token.unit) === normalizeUnit(operation.unit) &&
    normalizeMemo(token.memo) === normalizeMemo(command.memo) &&
    token.proofs.length === operation.inputProofSecrets.length &&
    token.proofs.every((proof, index) => proof.secret === operation.inputProofSecrets[index])
  );
}

async function loadOwnedReadyProofs(
  proofs: ProofRepository,
  operation: PreparedSendOperation,
): Promise<Proof[]> {
  const uniqueSecrets = new Set(operation.inputProofSecrets);
  if (uniqueSecrets.size !== operation.inputProofSecrets.length) {
    throw new ProofValidationError(`Send operation ${operation.id} contains duplicate inputs`);
  }
  const stored = await proofs.getProofsBySecrets(operation.mintUrl, operation.inputProofSecrets);
  const bySecret = new Map(stored.map((proof) => [proof.secret, proof]));
  const ordered = operation.inputProofSecrets.map((secret) => bySecret.get(secret));
  for (const proof of ordered) {
    if (
      !proof ||
      proof.mintUrl !== operation.mintUrl ||
      normalizeUnit(proof.unit) !== normalizeUnit(operation.unit) ||
      proof.state !== 'ready' ||
      proof.usedByOperationId !== operation.id
    ) {
      throw new ProofValidationError(
        `Send operation ${operation.id} does not own every ready input proof`,
      );
    }
  }
  const resolved = ordered as Proof[];
  if (
    !sumProofs(resolved).equals(operation.amount) ||
    !operation.inputAmount.equals(operation.amount) ||
    !operation.fee.isZero()
  ) {
    throw new ProofValidationError(`Send operation ${operation.id} is not an exact proof match`);
  }
  return resolved;
}

function normalizeMemo(memo: string | undefined): string | undefined {
  const trimmed = memo?.trim();
  return trimmed ? trimmed : undefined;
}

function assertSwapResult(
  operation: ExecutingSendOperation | PendingSendOperation,
  command: ApplySwapResultCommand,
): void {
  assertProofSet(operation, command.keepProofs, 'ready', 'keep');
  assertProofSet(operation, command.sendProofs, 'inflight', 'send');

  if (
    command.token.mint !== operation.mintUrl ||
    normalizeUnit(command.token.unit) !== normalizeUnit(operation.unit) ||
    command.token.memo !== operation.executionMemo ||
    !sameProofSet(command.token.proofs, command.sendProofs)
  ) {
    throw new ProofValidationError('Swap token does not match the persisted Send request');
  }
}

function assertProofSet(
  operation: ExecutingSendOperation | PendingSendOperation,
  proofs: CoreProof[],
  state: CoreProof['state'],
  kind: 'keep' | 'send',
): void {
  const outputSecrets = getSecretsFromSerializedOutputData(operation.outputData!);
  const expectedSecrets = kind === 'keep' ? outputSecrets.keepSecrets : outputSecrets.sendSecrets;
  if (
    new Set(expectedSecrets).size !== expectedSecrets.length ||
    new Set(proofs.map((proof) => proof.secret)).size !== proofs.length ||
    proofs.length !== expectedSecrets.length
  ) {
    throw new ProofValidationError(`Swap ${kind} proofs do not match allocated outputs`);
  }
  const allocation = operation.outputData![kind];
  const expected = new Map(
    allocation.map((output, index) => [
      expectedSecrets[index]!,
      {
        id: output.blindedMessage.id,
        amount: Amount.from(output.blindedMessage.amount),
      },
    ]),
  );
  for (const proof of proofs) {
    const output = expected.get(proof.secret);
    if (
      !output ||
      proof.id !== output.id ||
      !Amount.from(proof.amount).equals(output.amount) ||
      proof.mintUrl !== operation.mintUrl ||
      normalizeUnit(proof.unit) !== normalizeUnit(operation.unit) ||
      proof.state !== state ||
      proof.createdByOperationId !== operation.id
    ) {
      throw new ProofValidationError(`Swap ${kind} proofs do not match allocated outputs`);
    }
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

function assertCurrentActiveKeys(
  operation: InitSendOperation,
  activeKeys: MintKeys,
  keysets: Awaited<ReturnType<KeysetRepository['getKeysetsByMintUrl']>>,
): void {
  const keyset = keysets.find((candidate) => candidate.id === activeKeys.id);
  const sameKeys =
    keyset &&
    JSON.stringify(Object.entries(keyset.keypairs).sort()) ===
      JSON.stringify(Object.entries(activeKeys.keys).sort());
  if (
    !keyset ||
    !keyset.active ||
    normalizeUnit(keyset.unit) !== normalizeUnit(operation.unit) ||
    normalizeUnit(activeKeys.unit) !== normalizeUnit(operation.unit) ||
    !sameKeys
  ) {
    throw new SendOperationConflictError(
      operation.id,
      `Active keyset ${activeKeys.id} changed after Send preflight`,
    );
  }
}

function selectInputs(
  operation: InitSendOperation,
  available: Proof[],
  keyChain: KeyChain,
  selectProofs: SelectProofs,
): { proofs: Proof[]; fee: Amount; needsSwap: boolean } {
  const unit = normalizeUnit(operation.unit);
  for (const proof of available) {
    assertSameUnit(normalizeUnit((proof as { unit?: string }).unit), unit, 'Send proof selection');
  }
  if (sumProofs(available).lessThan(operation.amount)) {
    throw new ProofValidationError('Not enough proofs to send');
  }

  const forceSwap =
    operation.method === 'p2pk' ||
    (operation.method === 'default' &&
      Boolean((operation.methodData as { forceSwap?: boolean }).forceSwap));
  if (!forceSwap) {
    const exact = selectProofs(available, operation.amount, keyChain, false).send;
    if (sumProofs(exact).equals(operation.amount)) {
      return { proofs: exact, fee: Amount.zero(), needsSwap: false };
    }
  }

  const selected = selectProofs(available, operation.amount, keyChain, true).send;
  const fee = calculateFee(selected, keyChain);
  if (selected.length > 0 && sumProofs(selected).greaterThanOrEqual(operation.amount.add(fee))) {
    return { proofs: selected, fee, needsSwap: true };
  }
  throw new ProofValidationError('Send amount is not sufficient after fees');
}

function calculateFee(proofs: readonly Proof[], keyChain: KeyChain): Amount {
  const ppk = proofs.reduce((sum, proof) => {
    let fee: number;
    try {
      fee = keyChain.getKeyset(proof.id).fee;
    } catch {
      throw new ProofValidationError(`Missing fee preflight for keyset ${proof.id}`);
    }
    return sum + BigInt(fee);
  }, 0n);
  return Amount.from((ppk + 999n) / 1000n);
}
