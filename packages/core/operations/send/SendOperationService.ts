import {
  OutputData,
  type OutputDataCreator,
  type Proof,
  type Token,
  type ProofState as CashuProofState,
} from '@cashu/cashu-ts';
import type { ProofQueries } from '@core/proofs/ProofQueries.ts';
import { createKeyChain } from '@core/proofs/KeysetSelection.ts';
import {
  MINT_REFRESH_TTL_S,
  type MintMetadata,
  type MintQueries,
} from '@core/mints/MintMetadata.ts';
import type {
  SendOperation,
  InitSendOperation,
  PreparedSendOperation,
  ExecutingSendOperation,
  PendingSendOperation,
} from './SendOperation';
import {
  createSendOperation,
  getSendProofSecrets,
  type CreateSendOperationOptions,
} from './SendOperation';
import type { SendMethod, SendMethodData } from './SendMethodHandler';
import { SendHandlerProvider } from '../../infra/handlers/send/SendHandlerProvider';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import {
  generateSubId,
  getSecretsFromSerializedOutputData,
  mapProofToCoreProof,
} from '../../utils';
import {
  MintOperationError,
  UnknownMintError,
  ProofValidationError,
  OperationInProgressError,
  SendOperationConflictError,
} from '../../models/Error';
import { MintScopedLock } from '../MintScopedLock';
import { OperationIdLock } from '../OperationIdLock';
import { normalizeUnitAmount, type UnitAmount } from '../../amounts.ts';
import type { SendTransactions } from '../../transactions/send/SendTransactions.ts';
import type { PreparedSendResult } from '../../transactions/send/types.ts';
import type {
  AppliedSwapResult,
  CompletedReclaim,
  CancelledPreparedSend,
  CompletedPendingSend,
  FailedSwapExecution,
  SwapTransportRequest,
} from '../../transactions/send/types.ts';
import type { SendOperationQueries } from './SendOperationQueries.ts';
import type { SendRemote, SendRemoteSession } from './SendRemote.ts';

const AMBIGUOUS_SWAP_MINT_ERROR_CODES = new Set([11001, 11002, 11003, 11004]);

type SwapExecutionOutcome =
  | { status: 'PENDING'; result: AppliedSwapResult }
  | { status: 'FAILED'; result: FailedSwapExecution; error: MintOperationError };

export interface SendOperationServiceDependencies {
  operationQueries: SendOperationQueries;
  proofQueries: ProofQueries;
  transactions: SendTransactions;
  mintQueries: MintQueries;
  remote: SendRemote;
  loadSeed: () => Promise<Uint8Array>;
  eventBus: Pick<EventBus<CoreEvents>, 'emit'>;
  handlerProvider: SendHandlerProvider;
  outputDataCreator?: OutputDataCreator;
  logger?: Logger;
  mintScopedLock?: MintScopedLock;
}

/**
 * Options applied when a prepared send operation is executed.
 */
export interface ExecuteSendOptions {
  /** Optional memo to persist on the shareable token. Whitespace-only memos are ignored. */
  memo?: string;
}

/**
 * Service that manages send operations as sagas.
 *
 * This service provides crash recovery and rollback capabilities for send operations
 * by breaking them into discrete steps: init → prepare → execute → finalize/rollback.
 */
export class SendOperationService {
  private readonly operationQueries: SendOperationQueries;
  private readonly proofQueries: ProofQueries;
  private readonly transactions: SendTransactions;
  private readonly mintQueries: MintQueries;
  private readonly remote: SendRemote;
  private readonly loadSeed: () => Promise<Uint8Array>;
  private readonly eventBus: Pick<EventBus<CoreEvents>, 'emit'>;
  private readonly handlerProvider: SendHandlerProvider;
  private readonly logger?: Logger;
  private readonly outputDataCreator: OutputDataCreator;

  /** In-memory lock to prevent concurrent operations on the same operation ID */
  private readonly operationIdLock = new OperationIdLock();
  /** Lock for the global recovery process */
  private recoveryLock: Promise<void> | null = null;
  /** In-memory lock to serialize proof selection/reservation per mint */
  private readonly mintScopedLock: MintScopedLock;

  constructor(dependencies: SendOperationServiceDependencies) {
    this.operationQueries = dependencies.operationQueries;
    this.proofQueries = dependencies.proofQueries;
    this.transactions = dependencies.transactions;
    this.mintQueries = dependencies.mintQueries;
    this.remote = dependencies.remote;
    this.loadSeed = dependencies.loadSeed;
    this.eventBus = dependencies.eventBus;
    this.handlerProvider = dependencies.handlerProvider;
    this.logger = dependencies.logger;
    this.outputDataCreator = dependencies.outputDataCreator ?? OutputData;
    this.mintScopedLock = dependencies.mintScopedLock ?? new MintScopedLock();
  }

  /**
   * Acquire a lock for an operation.
   * Returns a release function that must be called when the operation completes.
   * Throws if the operation is already locked.
   */
  private async acquireOperationLock(operationId: string): Promise<() => void> {
    return this.operationIdLock.acquire(operationId);
  }

  /**
   * Check if an operation is currently locked.
   */
  isOperationLocked(operationId: string): boolean {
    return this.operationIdLock.isLocked(operationId);
  }

  /**
   * Check if recovery is currently in progress.
   */
  isRecoveryInProgress(): boolean {
    return this.recoveryLock !== null;
  }

  /**
   * Create a new send operation.
   * This is the entry point for the saga.
   */
  async init<M extends SendMethod = 'default'>(
    mintUrl: string,
    amount: UnitAmount,
    options: CreateSendOperationOptions<M> = {
      method: 'default' as M,
      methodData: {} as SendMethodData<M>,
    },
  ): Promise<InitSendOperation> {
    const parsed = normalizeUnitAmount(amount);
    const trusted = await this.mintQueries.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    if (parsed.amount.isZero()) {
      throw new ProofValidationError('Amount must be a positive number');
    }

    const id = generateSubId();
    const operation = createSendOperation(id, mintUrl, parsed, options);

    this.logger?.debug('Send operation initialized in memory', {
      operationId: id,
      mintUrl,
      amount: parsed.amount,
      unit: parsed.unit,
      method: options.method,
    });

    return operation;
  }

  /**
   * Prepare the operation by reserving proofs and creating outputs.
   * After this step, the operation can be executed or rolled back.
   *
   * Throws if the operation is already in progress.
   */
  async prepare(operation: InitSendOperation): Promise<PreparedSendOperation> {
    const releaseLock = await this.acquireOperationLock(operation.id);
    let result: PreparedSendResult;
    try {
      const releaseMintLock = await this.mintScopedLock.acquire(operation.mintUrl);
      try {
        const handler = this.handlerProvider.get(operation.method);
        if (!(await this.mintQueries.isTrustedMint(operation.mintUrl))) {
          throw new UnknownMintError(`Mint ${operation.mintUrl} is not trusted`);
        }
        const metadata = await this.loadMintMetadata(operation.mintUrl);
        const keys = this.activeKeys(metadata, operation.unit);
        const seed = await this.loadSeed();
        const plan = handler.prepare({
          operation,
          activeKeys: keys,
          mintInfo: metadata.mint.mintInfo,
          outputDataCreator: this.outputDataCreator,
        });
        result = await this.transactions.prepare({
          operation: { ...operation, updatedAt: Date.now() },
          activeKeys: keys,
          seed,
          ...plan,
        });
      } finally {
        releaseMintLock();
      }
    } finally {
      releaseLock();
    }
    await this.publishPrepared(result);
    return result.operation;
  }

  /**
   * Execute the prepared operation.
   * Performs the swap (if needed) and creates the token.
   * If a memo is provided, trims it and persists it on the token before saving the
   * pending operation. Whitespace-only memos are omitted.
   *
   * Swap execution commits the exact request before contacting the mint and applies a successful
   * response in a second atomic transition. Ambiguous outcomes remain executing for recovery.
   * Throws if the operation is already in progress.
   */
  async execute(
    operation: PreparedSendOperation,
    options?: ExecuteSendOptions,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    const current = await this.operationQueries.getById(operation.id);
    if (!current) {
      throw new SendOperationConflictError(
        operation.id,
        `Send operation ${operation.id} not found`,
      );
    }
    if (current.state !== 'prepared' && !(current.state === 'pending' && !current.needsSwap)) {
      throw new SendOperationConflictError(
        operation.id,
        `Cannot execute Send operation in state ${current.state}`,
      );
    }
    return current.needsSwap
      ? this.executePreparedSwap(current.id, options)
      : this.executeExactMatch(current.id, options?.memo);
  }

  private async executePreparedSwap(
    operationId: string,
    options?: ExecuteSendOptions,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    const releaseLock = await this.acquireOperationLock(operationId);
    let outcome: SwapExecutionOutcome | undefined;
    try {
      const current = await this.operationQueries.getById(operationId);
      if (!current) {
        throw new Error(`Operation ${operationId} not found`);
      }
      if (current.state !== 'prepared') {
        throw new SendOperationConflictError(
          operationId,
          `Cannot execute Send operation in state ${current.state}`,
        );
      }

      outcome = await this.executeSwap(current, options);
    } finally {
      releaseLock();
    }

    if (!outcome) {
      throw new Error(`Send operation ${operationId} did not produce a pending result`);
    }
    if (outcome.status === 'FAILED') {
      await this.publishFailedSwap(outcome.result);
      throw outcome.error;
    }
    await this.publishAppliedSwap(outcome.result);
    return { operation: outcome.result.operation, token: outcome.result.operation.token! };
  }

  private async executeSwap(
    operation: PreparedSendOperation,
    options?: ExecuteSendOptions,
  ): Promise<SwapExecutionOutcome> {
    if (!operation.outputData) {
      throw new Error('Missing output data for swap operation');
    }
    const remote = this.remote.open(await this.loadMintMetadata(operation.mintUrl), operation.unit);
    const begun = await this.transactions.beginExecution({
      operationId: operation.id,
      updatedAt: Date.now(),
      memo: options?.memo ? this.normalizeMemo(options.memo) : undefined,
    });
    return this.submitPersistedSwap(begun.operation, begun.request, remote);
  }

  private async submitPersistedSwap(
    operation: ExecutingSendOperation,
    request: SwapTransportRequest,
    remote: SendRemoteSession,
  ): Promise<SwapExecutionOutcome> {
    let result: Awaited<ReturnType<SendRemoteSession['swap']>>;
    try {
      result = await remote.swap(request);
    } catch (error) {
      if (!this.isDefinitiveSwapFailure(error)) {
        throw error;
      }
      const failed = await this.transactions.failExecution({
        operationId: operation.id,
        updatedAt: Date.now(),
        error: error.message,
      });
      return { status: 'FAILED', result: failed, error };
    }
    const keepProofs = mapProofToCoreProof(request.mintUrl, 'ready', result.keep, {
      unit: request.unit,
      createdByOperationId: operation.id,
    });
    const sendProofs = mapProofToCoreProof(request.mintUrl, 'inflight', result.send, {
      unit: request.unit,
      createdByOperationId: operation.id,
    });
    const token: Token = {
      mint: request.mintUrl,
      proofs: result.send,
      unit: request.unit,
      ...(operation.executionMemo ? { memo: operation.executionMemo } : {}),
    };

    const applied = await this.transactions.applyResult({
      operationId: operation.id,
      updatedAt: Date.now(),
      keepProofs,
      sendProofs,
      token,
    });
    return { status: 'PENDING', result: applied };
  }

  private async executeExactMatch(
    operationId: string,
    memo?: string,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    const releaseLock = await this.acquireOperationLock(operationId);
    let result: Awaited<ReturnType<SendTransactions['executeExact']>>;
    try {
      result = await this.transactions.executeExact({
        operationId,
        updatedAt: Date.now(),
        memo,
      });
    } finally {
      releaseLock();
    }

    if (result.committed) {
      await this.publishCommittedEvent('proofs:state-changed', {
        mintUrl: result.operation.mintUrl,
        secrets: result.operation.inputProofSecrets,
        state: 'inflight',
      });
      await this.publishCommittedEvent('send:pending', {
        mintUrl: result.operation.mintUrl,
        operationId: result.operation.id,
        operation: result.operation,
        token: result.token,
      });
    }

    this.logger?.info('Exact-match Send operation executed', {
      operationId,
      proofCount: result.token.proofs.length,
      committed: result.committed,
    });
    return result;
  }

  /**
   * High-level send method that orchestrates init → prepare → execute.
   * This is the main entry point for consumers.
   */
  async send(mintUrl: string, amount: UnitAmount): Promise<Token> {
    const initOp = await this.init(mintUrl, amount);
    const preparedOp = await this.prepare(initOp);
    const { token } = await this.execute(preparedOp);
    return token;
  }

  /**
   * Finalize a pending operation after its proofs have been spent.
   * This method is idempotent - calling it on an already finalized operation is a no-op.
   * If the operation was rolled back, finalization is skipped (rollback takes precedence).
   * Throws if the operation is already in progress.
   */
  async finalize(operationId: string): Promise<void> {
    const operation = await this.operationQueries.getById(operationId);
    if (!operation) throw new Error(`Operation ${operationId} not found`);
    return this.completePersistedSend(operationId);
  }

  private async completePersistedSend(operationId: string): Promise<void> {
    let releaseLock: (() => void) | undefined;
    let result: CompletedPendingSend | undefined;
    try {
      try {
        releaseLock = await this.acquireOperationLock(operationId);
      } catch (error) {
        if (!(error instanceof OperationInProgressError)) {
          throw error;
        }

        await this.operationIdLock.waitForUnlock(operationId);

        const latest = await this.operationQueries.getById(operationId);
        if (!latest) {
          throw new Error(`Operation ${operationId} not found`);
        }

        if (latest.state === 'finalized') {
          this.logger?.debug('Operation finalized while waiting for lock', { operationId });
          return;
        }

        if (latest.state === 'rolled_back' || latest.state === 'rolling_back') {
          this.logger?.debug('Operation rolled back while waiting for lock', {
            operationId,
            state: latest.state,
          });
          return;
        }

        releaseLock = await this.acquireOperationLock(operationId);
      }

      const operation = await this.operationQueries.getById(operationId);
      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
      }
      if (operation.state === 'finalized') {
        this.logger?.debug('Operation already finalized', { operationId });
        return;
      }

      if (operation.state === 'rolled_back' || operation.state === 'rolling_back') {
        this.logger?.debug('Operation was rolled back or is rolling back, skipping finalization', {
          operationId,
        });
        return;
      }

      if (operation.state !== 'pending') {
        throw new Error(`Cannot finalize operation in state ${operation.state}`);
      }
      const sendSecrets = getSendProofSecrets(operation);
      const localProofs = await this.proofQueries.getProofsBySecrets(
        operation.mintUrl,
        sendSecrets,
      );
      const locallySpent =
        localProofs.length === new Set(sendSecrets).size &&
        localProofs.every((proof) => proof.state === 'spent');
      let observedSpentSecrets: string[] | undefined;
      if (!locallySpent) {
        const states = await this.checkProofStatesWithMint(
          operation.mintUrl,
          sendSecrets,
          operation.unit,
        );
        if (!states.every((state) => state.state === 'SPENT')) {
          throw new ProofValidationError(`Cannot finalize unspent Send operation ${operationId}`);
        }
        observedSpentSecrets = sendSecrets;
      }
      result = await this.transactions.completePending({
        operationId,
        updatedAt: Date.now(),
        spentProofSecrets: observedSpentSecrets,
      });
    } finally {
      releaseLock?.();
    }
    if (result) await this.publishCompletedSend(result);
  }

  /**
   * Cancel a prepared operation and release its reservations.
   * Reclaim commits its Output Allocation before mint I/O and applies the result atomically.
   * Throws if the operation is already in progress.
   */
  async rollback(operationId: string, reason = 'Rolled back by user action'): Promise<void> {
    const operation = await this.operationQueries.getById(operationId);
    if (!operation) throw new Error(`Operation ${operationId} not found`);
    const handler = this.handlerProvider.get(operation.method);
    if (operation.state !== 'prepared' && !handler.canReclaim) {
      throw new Error(`P2PK Send Operation in ${operation.state} state can not be rolled back.`);
    }
    return this.rollbackPersistedSend(operationId, reason);
  }

  private async rollbackPersistedSend(operationId: string, reason: string): Promise<void> {
    const releaseLock = await this.acquireOperationLock(operationId);
    let cancelled: CancelledPreparedSend | undefined;
    let reclaimed: CompletedReclaim | undefined;
    try {
      const operation = await this.operationQueries.getById(operationId);
      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
      }
      if (operation.state === 'prepared') {
        cancelled = await this.transactions.cancelPrepared({
          operationId,
          updatedAt: Date.now(),
          reason,
        });
      } else if (operation.state === 'pending' && operation.method === 'default') {
        const metadata = await this.loadMintMetadata(operation.mintUrl);
        const remote = this.remote.open(metadata, operation.unit);
        const begun = await this.transactions.beginReclaim({
          operationId,
          updatedAt: Date.now(),
          activeKeys: this.activeKeys(metadata, operation.unit),
          seed: await this.loadSeed(),
        });
        if (begun.counter) await this.publishCommittedEvent('counter:updated', begun.counter);
        if (begun.skippedForFees) {
          this.logger?.warn('Cannot reclaim send proofs because fees consume the amount', {
            operationId,
          });
        }
        const proofs = begun.operation.reclaimData
          ? await remote.reclaim(begun.inputProofs, begun.operation.reclaimData.outputData)
          : [];
        reclaimed = await this.transactions.completeReclaim({
          operationId,
          updatedAt: Date.now(),
          reason,
          proofs: mapProofToCoreProof(operation.mintUrl, 'ready', proofs, { unit: operation.unit }),
        });
      } else {
        throw new Error(`Cannot rollback operation in state ${operation.state}`);
      }
    } finally {
      releaseLock();
    }
    if (cancelled) await this.publishCancelledSend(cancelled);
    if (reclaimed) {
      await this.publishSavedProofs(reclaimed.operation.mintUrl, reclaimed.savedProofs);
      if (reclaimed.spentProofSecrets.length > 0)
        await this.publishCommittedEvent('proofs:state-changed', {
          mintUrl: reclaimed.operation.mintUrl,
          secrets: reclaimed.spentProofSecrets,
          state: 'spent',
        });
      if (reclaimed.releasedProofSecrets.length > 0)
        await this.publishCommittedEvent('proofs:released', {
          mintUrl: reclaimed.operation.mintUrl,
          secrets: reclaimed.releasedProofSecrets,
        });
      await this.publishCommittedEvent('send:rolled-back', {
        mintUrl: reclaimed.operation.mintUrl,
        operationId: reclaimed.operation.id,
        operation: reclaimed.operation,
      });
    }
  }

  /**
   * Recover pending operations on startup.
   * This should be called during initialization.
   * Throws if recovery is already in progress.
   */
  async recoverPendingOperations(): Promise<void> {
    if (this.recoveryLock) {
      throw new Error('Recovery is already in progress');
    }

    let releaseRecoveryLock: () => void;
    this.recoveryLock = new Promise<void>((resolve) => {
      releaseRecoveryLock = resolve;
    });

    try {
      let initCount = 0;
      let executingCount = 0;
      let pendingCount = 0;
      let rollingBackCount = 0;
      let orphanCount = 0;

      // 1. Clean up failed init operations
      const initOps = await this.operationQueries.getByState('init');
      for (const op of initOps) {
        await this.recoverInitOperation(op as InitSendOperation);
        initCount++;
      }

      // 2. Log warnings for prepared operations (leave for user to decide)
      const preparedOps = await this.operationQueries.getByState('prepared');
      for (const op of preparedOps) {
        this.logger?.warn('Found stale prepared operation, user can rollback manually', {
          operationId: op.id,
        });
      }

      // 3. Recover executing operations
      const executingOps = await this.operationQueries.getByState('executing');
      for (const op of executingOps) {
        try {
          await this.recoverExecutingOperation(op as ExecutingSendOperation);
          executingCount++;
        } catch (e) {
          this.logger?.error('Error recovering executing operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // 4. Check pending operations
      const pendingOps = await this.operationQueries.getByState('pending');
      for (const op of pendingOps) {
        try {
          await this.checkPendingOperation(op as PendingSendOperation);
          pendingCount++;
        } catch (e) {
          this.logger?.error('Error checking pending operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // 5. Warn about rolling_back operations (need manual intervention)
      // TODO: Implement automatic recovery for rolling_back operations.
      // New reclaims retain their output plan atomically, but automatic reclaim recovery remains
      // a separate behavior change. Older records may lack that plan. Preserve the existing
      // warning and manual seed Restore path for both.
      const rollingBackOps = await this.operationQueries.getByState('rolling_back');
      for (const op of rollingBackOps) {
        this.logger?.warn(
          'Found operation stuck in rolling_back state. ' +
            'This indicates a crash during rollback. Manual recovery via seed restore may be needed.',
          {
            operationId: op.id,
            mintUrl: op.mintUrl,
            amount: op.amount,
          },
        );
        rollingBackCount++;
      }

      // 6. Clean up orphaned proof reservations
      orphanCount = await this.cleanupOrphanedReservations();

      this.logger?.info('Recovery completed', {
        initOperations: initCount,
        executingOperations: executingCount,
        pendingOperations: pendingCount,
        rollingBackOperations: rollingBackCount,
        orphanedReservations: orphanCount,
      });
    } finally {
      this.recoveryLock = null;
      releaseRecoveryLock!();
    }
  }

  /**
   * Clean up a failed init operation.
   * Releases any orphaned proof reservations and deletes the operation.
   */
  private async recoverInitOperation(op: InitSendOperation): Promise<void> {
    const result = await this.transactions.cleanupLegacyInit(op.id);
    if (result.releasedProofSecrets.length > 0) {
      await this.publishCommittedEvent('proofs:released', {
        mintUrl: result.mintUrl,
        secrets: result.releasedProofSecrets,
      });
    }
    this.logger?.info('Cleaned up failed init operation', { operationId: op.id });
  }

  /**
   * Recover an executing swap using only its persisted inputs, outputs, and memo.
   */
  private async recoverExecutingOperation(op: ExecutingSendOperation): Promise<void> {
    const latest = await this.operationQueries.getById(op.id);
    if (!latest || latest.state !== 'executing') {
      this.logger?.debug('Skipping executing Send recovery because state changed', {
        operationId: op.id,
        state: latest?.state,
      });
      return;
    }
    if (!latest.needsSwap || !latest.outputData) {
      this.logger?.warn('Executing Send lacks a persisted swap request; leaving it for recovery', {
        operationId: latest.id,
      });
      return;
    }

    const storedInputs = await this.proofQueries.getProofsBySecrets(
      latest.mintUrl,
      latest.inputProofSecrets,
    );
    const inputBySecret = new Map(storedInputs.map((proof) => [proof.secret, proof]));
    if (inputBySecret.size !== latest.inputProofSecrets.length) {
      throw new ProofValidationError('Cannot recover Send operation: missing input proof metadata');
    }
    const inputProofs = latest.inputProofSecrets.map(
      (secret) => inputBySecret.get(secret) as Proof,
    );
    const remote = this.remote.open(await this.loadMintMetadata(latest.mintUrl), latest.unit);
    const inputStates = await remote.checkProofStates(inputProofs);
    if (inputStates.length !== inputProofs.length) {
      this.logger?.warn(
        'Executing Send proof-state response was incomplete; preserving recovery material',
        { operationId: latest.id },
      );
      return;
    }
    const allUnspent = inputStates.every((state) => state.state === 'UNSPENT');
    const allSpent = inputStates.every((state) => state.state === 'SPENT');

    if (allUnspent) {
      const claimed = await this.transactions.claimRecovery({
        operationId: latest.id,
        expectedRevision: latest.revision ?? 0,
        updatedAt: Date.now(),
      });
      const outcome = await this.submitPersistedSwap(claimed.operation, claimed.request, remote);
      if (outcome.status === 'FAILED') {
        await this.publishFailedSwap(outcome.result);
      } else {
        await this.publishAppliedSwap(outcome.result);
      }
      this.logger?.info('Replayed executing Send from its persisted request', {
        operationId: latest.id,
        result: outcome.status,
      });
      return;
    }

    if (!allSpent) {
      this.logger?.warn('Executing Send outcome remains ambiguous; preserving recovery material', {
        operationId: latest.id,
      });
      return;
    }

    const claimed = await this.transactions.claimRecovery({
      operationId: latest.id,
      expectedRevision: latest.revision ?? 0,
      updatedAt: Date.now(),
    });
    const recoveryOperation = claimed.operation;

    const recovered = await remote.restoreOutputs(recoveryOperation.outputData!);
    const outputSecrets = getSecretsFromSerializedOutputData(recoveryOperation.outputData!);
    const expectedSecrets = [...outputSecrets.keepSecrets, ...outputSecrets.sendSecrets];
    const recoveredBySecret = new Map(recovered.map((proof) => [proof.secret, proof]));
    if (!expectedSecrets.every((secret) => recoveredBySecret.has(secret))) {
      this.logger?.warn(
        'Executing Send outputs could not be fully reconstructed; preserving recovery material',
        { operationId: recoveryOperation.id },
      );
      return;
    }

    const keepProofs = mapProofToCoreProof(
      recoveryOperation.mintUrl,
      'ready',
      outputSecrets.keepSecrets.map((secret) => recoveredBySecret.get(secret)!),
      { unit: recoveryOperation.unit, createdByOperationId: recoveryOperation.id },
    );
    const sendProofs = mapProofToCoreProof(
      recoveryOperation.mintUrl,
      'inflight',
      outputSecrets.sendSecrets.map((secret) => recoveredBySecret.get(secret)!),
      { unit: recoveryOperation.unit, createdByOperationId: recoveryOperation.id },
    );
    const token: Token = {
      mint: recoveryOperation.mintUrl,
      proofs: outputSecrets.sendSecrets.map((secret) => recoveredBySecret.get(secret)!),
      unit: recoveryOperation.unit,
      ...(recoveryOperation.executionMemo ? { memo: recoveryOperation.executionMemo } : {}),
    };
    const applied = await this.transactions.applyResult({
      operationId: recoveryOperation.id,
      updatedAt: Date.now(),
      keepProofs,
      sendProofs,
      token,
    });
    await this.publishAppliedSwap(applied);
    this.logger?.info('Restored executing Send outputs from its persisted request', {
      operationId: recoveryOperation.id,
    });
  }

  /**
   * Check a pending operation to see if it should be finalized.
   */
  async checkPendingOperation(op: PendingSendOperation): Promise<void> {
    const latest = await this.operationQueries.getById(op.id);
    if (!latest || latest.state !== 'pending') return;
    return this.checkPersistedSend(latest);
  }

  private async checkPersistedSend(op: PendingSendOperation): Promise<void> {
    const latest = await this.operationQueries.getById(op.id);
    if (!latest || latest.state !== 'pending') return;
    const sendSecrets = getSendProofSecrets(latest);
    let sendStates: CashuProofState[];
    try {
      sendStates = await this.checkProofStatesWithMint(latest.mintUrl, sendSecrets, latest.unit);
    } catch (_e) {
      this.logger?.warn('Could not reach mint for recovery, will retry later', {
        operationId: latest.id,
        mintUrl: latest.mintUrl,
      });
      return;
    }

    if (!sendStates.every((state) => state.state === 'SPENT')) {
      this.logger?.debug('Pending operation token not yet claimed, leaving as pending', {
        operationId: latest.id,
      });
      return;
    }

    const result = await this.transactions.completePending({
      operationId: latest.id,
      updatedAt: Date.now(),
      spentProofSecrets: sendSecrets,
    });
    await this.publishCompletedSend(result);
    this.logger?.info('Send operation finalized during recovery', { operationId: latest.id });
  }

  /**
   * Persist a mint proof-state notification through the Send transaction boundary. The last send
   * proof observation and the pending-to-finalized transition commit together.
   */
  async recordProofSpent(operationId: string, secret: string): Promise<boolean> {
    const operation = await this.operationQueries.getById(operationId);
    if (!operation || operation.state !== 'pending') return false;
    const result = await this.transactions.completePending({
      operationId,
      updatedAt: Date.now(),
      spentProofSecrets: [secret],
    });
    await this.publishCompletedSend(result);
    return true;
  }

  /**
   * Check proof states with the mint.
   */
  private async checkProofStatesWithMint(
    mintUrl: string,
    secrets: string[],
    unit: string,
  ): Promise<CashuProofState[]> {
    const remote = this.remote.open(await this.loadMintMetadata(mintUrl), unit);
    const proofInputs = await this.proofQueries.getProofsBySecrets(mintUrl, secrets);
    if (proofInputs.length !== secrets.length) {
      throw new ProofValidationError('Cannot check proof states: missing proof metadata');
    }
    const states = await remote.checkProofStates(proofInputs);
    if (states.length !== proofInputs.length) {
      throw new ProofValidationError('Cannot check proof states: incomplete mint response');
    }
    return states;
  }

  /**
   * Clean up orphaned proof reservations.
   * Finds proofs that are reserved but point to non-existent or terminal operations.
   */
  private async cleanupOrphanedReservations(): Promise<number> {
    const result = await this.transactions.cleanupOrphanedReservations();
    for (const group of result.released) {
      await this.publishCommittedEvent('proofs:released', group);
    }
    if (result.count > 0) {
      this.logger?.info('Released orphaned proof reservations', { count: result.count });
    }
    return result.count;
  }

  private async publishPrepared(result: PreparedSendResult): Promise<void> {
    if (result.counter) {
      await this.publishCommittedEvent('counter:updated', result.counter);
    }
    await this.publishCommittedEvent('proofs:reserved', {
      mintUrl: result.reservation.mintUrl,
      operationId: result.reservation.operationId,
      secrets: result.reservation.secrets,
      amount: {
        amount: result.reservation.amount,
        unit: result.reservation.unit,
      },
    });
    await this.publishCommittedEvent('send:prepared', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
    });
  }

  private async publishSavedProofs(
    mintUrl: string,
    savedProofs: import('@core/types.ts').CoreProof[],
  ): Promise<void> {
    const groups = new Map<string, typeof savedProofs>();
    for (const proof of savedProofs) groups.set(proof.id, [...(groups.get(proof.id) ?? []), proof]);
    for (const [keysetId, proofs] of groups)
      await this.publishCommittedEvent('proofs:saved', { mintUrl, keysetId, proofs });
  }

  private async publishAppliedSwap(result: AppliedSwapResult): Promise<void> {
    if (!result.committed) return;

    await this.publishSavedProofs(result.operation.mintUrl, result.savedProofs);
    await this.publishCommittedEvent('proofs:state-changed', {
      mintUrl: result.operation.mintUrl,
      secrets: result.spentInputSecrets,
      state: 'spent',
    });
    await this.publishCommittedEvent('send:pending', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
      token: result.operation.token!,
    });
  }

  private async publishFailedSwap(result: FailedSwapExecution): Promise<void> {
    if (!result.committed) return;

    await this.publishCommittedEvent('proofs:released', {
      mintUrl: result.operation.mintUrl,
      secrets: result.releasedInputSecrets,
    });
    await this.publishCommittedEvent('send:rolled-back', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
    });
  }

  private async publishCancelledSend(result: CancelledPreparedSend): Promise<void> {
    if (!result.committed) return;
    await this.publishCommittedEvent('proofs:released', {
      mintUrl: result.operation.mintUrl,
      secrets: result.releasedInputSecrets,
    });
    await this.publishCommittedEvent('send:rolled-back', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
    });
    this.logger?.info('Prepared Send operation cancelled', { operationId: result.operation.id });
  }

  private async publishCompletedSend(result: CompletedPendingSend): Promise<void> {
    if (!result.committed) return;
    if (result.spentProofSecrets.length > 0) {
      await this.publishCommittedEvent('proofs:state-changed', {
        mintUrl: result.operation.mintUrl,
        secrets: result.spentProofSecrets,
        state: 'spent',
      });
    }
    if (result.releasedInputSecrets.length > 0) {
      await this.publishCommittedEvent('proofs:released', {
        mintUrl: result.operation.mintUrl,
        secrets: result.releasedInputSecrets,
      });
    }
    if (result.operation.state === 'finalized') {
      await this.publishCommittedEvent('send:finalized', {
        mintUrl: result.operation.mintUrl,
        operationId: result.operation.id,
        operation: result.operation,
      });
      this.logger?.info('Send operation finalized', { operationId: result.operation.id });
    }
  }

  private async loadMintMetadata(mintUrl: string): Promise<MintMetadata> {
    const cached = await this.mintQueries.getMetadata(mintUrl);
    if (cached && cached.mint.updatedAt >= Math.floor(Date.now() / 1000) - MINT_REFRESH_TTL_S)
      return cached;
    const observation = await this.remote.fetchMintMetadata(mintUrl, cached?.keysets ?? []);
    const refreshed = await this.transactions.refreshMintMetadata(observation);
    await this.publishCommittedEvent('mint:metadata-refreshed', { mintUrl });
    await this.publishCommittedEvent('mint:updated', refreshed);
    return refreshed;
  }

  private activeKeys(metadata: MintMetadata, unit: string) {
    const keys = createKeyChain(metadata.mint.mintUrl, unit, metadata.keysets)
      .getCheapestKeyset()
      .toMintKeys();
    if (!keys) throw new ProofValidationError('Active keyset is missing mint keys');
    return keys;
  }

  private isDefinitiveSwapFailure(error: unknown): error is MintOperationError {
    return error instanceof MintOperationError && !AMBIGUOUS_SWAP_MINT_ERROR_CODES.has(error.code);
  }

  private async publishCommittedEvent<E extends keyof CoreEvents>(
    event: E,
    payload: CoreEvents[E],
  ): Promise<void> {
    try {
      await this.eventBus.emit(event, payload, { throwOnError: true });
    } catch (error) {
      this.logger?.error('Failed to publish committed Send event', { event, error });
    }
  }

  private normalizeMemo(memo: string): string | undefined {
    const trimmed = memo.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Get an operation by ID.
   */
  async getOperation(operationId: string): Promise<SendOperation | null> {
    return this.operationQueries.getById(operationId);
  }

  /**
   * Get all pending operations.
   */
  async getPendingOperations(): Promise<SendOperation[]> {
    return this.operationQueries.getPending();
  }

  /**
   * Get all prepared operations.
   */
  async getPreparedOperations(): Promise<PreparedSendOperation[]> {
    const ops = await this.operationQueries.getByState('prepared');
    return ops.filter((op): op is PreparedSendOperation => op.state === 'prepared');
  }
}
