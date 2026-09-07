import {
  MINT_REFRESH_TTL_S,
  type MintMetadata,
  type MintQueries,
} from '@core/mints/MintMetadata.ts';
import type { P2pkSigner } from '@core/keypairs/P2pkSigner.ts';
import type { ProofQueries } from '@core/proofs/ProofQueries.ts';
import { createKeyChain } from '@core/proofs/KeysetSelection.ts';
import { prepareProofsForReceiving } from '@core/proofs/ProofPreparation.ts';
import { decodeTokenWithKeysets } from '@core/tokens/TokenDecoding.ts';
import type { ReceiveRemote } from './ReceiveRemote.ts';
import {
  getTokenMetadata,
  sumProofs,
  type Proof,
  type ProofState as CashuProofState,
  type Token,
} from '@cashu/cashu-ts';

import { generateSubId, normalizeMintUrl, mapProofToCoreProof } from '../../utils';
import {
  UnknownMintError,
  TokenValidationError,
  MintOperationError,
  ProofValidationError,
  OperationInProgressError,
} from '../../models/Error';
import type {
  ReceiveOperation,
  ReceiveOperationSource,
  InitReceiveOperation,
  PreparedReceiveOperation,
  PreparedOrLaterOperation,
  ExecutingReceiveOperation,
  FinalizedReceiveOperation,
} from './ReceiveOperation';
import type { Logger } from '../../logging/Logger';
import type { CoreEvents } from '../../events/types';
import type { EventBus } from '../../events/EventBus';
import { createReceiveOperation, getOutputProofSecrets } from './ReceiveOperation';
import { OperationIdLock } from '../OperationIdLock';
import { MintScopedLock } from '../MintScopedLock';
import { DEFAULT_UNIT, normalizeUnit } from '../../amounts.ts';
import type { ReceiveTransactions } from '../../transactions/receive/ReceiveTransactions.ts';
import type { ReceiveOperationQueries } from './ReceiveOperationQueries.ts';
import type {
  AppliedReceiveResult,
  FailedReceiveExecution,
  PreparedReceiveResult,
  ReceiveTransportRequest,
} from '../../transactions/receive/types.ts';

const NON_TERMINAL_RECEIVE_MINT_ERROR_CODES = new Set([
  // Pending inputs or outputs and already-signed outputs do not prove the exact persisted
  // request had no effect. Keep the operation executing so recovery can reconcile it.
  11002, 11003, 11004,
]);

type ReceiveExecutionOutcome =
  | { status: 'FINALIZED'; result: AppliedReceiveResult }
  | { status: 'FAILED'; result: FailedReceiveExecution; error: MintOperationError };

export interface ReceiveOperationServiceDependencies {
  operationQueries: ReceiveOperationQueries;
  proofQueries: Pick<ProofQueries, 'getProofsBySecrets'>;
  transactions: ReceiveTransactions;
  mintQueries: MintQueries;
  signer: P2pkSigner;
  loadSeed: () => Promise<Uint8Array>;
  remote: ReceiveRemote;
  eventBus: Pick<EventBus<CoreEvents>, 'emit'>;
  logger?: Logger;
  mintScopedLock?: MintScopedLock;
}

/**
 * Service that manages receive operations as sagas.
 *
 * This service provides crash recovery and rollback capabilities for receive operations
 * By breaking them into discrete step:  init → prepare → execute → finalized
 * rolledback for failure state
 */
export class ReceiveOperationService {
  private readonly operationQueries: ReceiveOperationQueries;
  private readonly proofQueries: Pick<ProofQueries, 'getProofsBySecrets'>;
  private readonly transactions: ReceiveTransactions;
  private readonly mintQueries: MintQueries;
  private readonly signer: P2pkSigner;
  private readonly loadSeed: () => Promise<Uint8Array>;
  private readonly remote: ReceiveRemote;
  private readonly eventBus: Pick<EventBus<CoreEvents>, 'emit'>;
  private readonly logger?: Logger;

  /** In-memory lock to prevent concurrent operations on the same operation ID */
  private readonly operationIdLock = new OperationIdLock();
  /** Lock for the global recovery process */
  private recoveryLock: Promise<void> | null = null;
  /** In-session coordination with legacy workflows; the transaction owns counter safety. */
  private readonly mintScopedLock: MintScopedLock;

  constructor(dependencies: ReceiveOperationServiceDependencies) {
    this.operationQueries = dependencies.operationQueries;
    this.proofQueries = dependencies.proofQueries;
    this.transactions = dependencies.transactions;
    this.mintQueries = dependencies.mintQueries;
    this.signer = dependencies.signer;
    this.loadSeed = dependencies.loadSeed;
    this.remote = dependencies.remote;
    this.eventBus = dependencies.eventBus;
    this.logger = dependencies.logger;
    this.mintScopedLock = dependencies.mintScopedLock ?? new MintScopedLock();
  }

  /**
   * Acquire an in-memory lock for a specific operation to prevent concurrency races.
   * Returns a release function that must be called in a finally block.
   * Throws if the operation is already locked.
   */
  private async acquireOperationLock(operationId: string): Promise<() => void> {
    return this.operationIdLock.acquire(operationId);
  }

  /** Check if an operation is currently locked (for concurrency control). */
  isOperationLocked(operationId: string): boolean {
    return this.operationIdLock.isLocked(operationId);
  }

  /** Check if a recovery sweep is in progress. */
  isRecoveryInProgress(): boolean {
    return this.recoveryLock !== null;
  }

  /**
   * Create a new receive operation by decoding and validating the token.
   * The returned intent is not persisted. Preparation creates the first durable row atomically.
   */
  async init(
    token: Token | string,
    source?: ReceiveOperationSource,
  ): Promise<InitReceiveOperation> {
    const mintUrl = this.extractMintUrl(token);
    const trusted = await this.mintQueries.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    const metadata = await this.loadMintMetadata(mintUrl).catch((error: unknown) => {
      throw new TokenValidationError(
        error instanceof Error ? error.message : 'Unable to retrieve mint keysets',
      );
    });
    const decodedToken = decodeTokenWithKeysets(token, metadata.keysets);
    const unit = normalizeUnit(decodedToken.unit, { defaultUnit: DEFAULT_UNIT });
    const proofs = decodedToken.proofs;

    const preparedProofs = await prepareProofsForReceiving(proofs, this.signer, this.logger);
    if (!Array.isArray(preparedProofs) || preparedProofs.length === 0) {
      this.logger?.warn('Token contains no proofs', { mintUrl });
      throw new ProofValidationError('Token contains no proofs');
    }

    const amount = sumProofs(preparedProofs);
    if (amount.isZero()) {
      this.logger?.warn('Token has invalid or non-positive amount', { mintUrl, amount });
      throw new ProofValidationError('Token amount must be a positive integer');
    }

    const id = generateSubId();
    const operation = createReceiveOperation(id, mintUrl, { amount, unit }, preparedProofs, source);

    this.logger?.debug('Receive operation initialized in memory', {
      operationId: id,
      mintUrl,
      amount,
      proofCount: preparedProofs.length,
    });

    return operation;
  }

  /**
   * Prepare the operation by calculating fees and creating deterministic outputs.
   * Transitions init -> prepared and stores outputData for crash recovery.
   */
  async prepare(operation: InitReceiveOperation): Promise<PreparedReceiveOperation> {
    const releaseLock = await this.acquireOperationLock(operation.id);
    let result: PreparedReceiveResult;
    try {
      // Coordinate with legacy mint/melt workflows in this session. Shared scoped allocation
      // and adapter transactions protect Send/Receive counters across sessions.
      const releaseMintLock = await this.mintScopedLock.acquire(operation.mintUrl);
      try {
        const current = await this.operationQueries.getById(operation.id);
        if (current && current.state !== 'init') {
          throw new Error(`Cannot prepare operation in state '${current.state}'. Expected 'init'.`);
        }
        const intent = current ? (current as InitReceiveOperation) : operation;
        result = await this.prepareInternal(intent);
      } finally {
        releaseMintLock();
      }
    } finally {
      releaseLock();
    }
    await this.publishPrepared(result);
    return result.operation;
  }

  /** Internal prepare logic used by prepare(), separated for error handling. */
  private async prepareInternal(operation: InitReceiveOperation): Promise<PreparedReceiveResult> {
    if (!operation.inputProofs || operation.inputProofs.length === 0) {
      throw new ProofValidationError('Receive operation has no input proofs');
    }

    const { mintUrl } = operation;
    const metadata = await this.loadMintMetadata(mintUrl);
    const keys = createKeyChain(mintUrl, operation.unit, metadata.keysets)
      .getCheapestKeyset()
      .toMintKeys();
    if (!keys) throw new ProofValidationError('Active keyset is missing mint keys');
    const seed = await this.loadSeed();
    const result = await this.transactions.prepare({
      operation: { ...operation, updatedAt: Date.now() },
      activeKeys: keys,
      seed,
    });

    this.logger?.info('Receive operation prepared', {
      operationId: operation.id,
      mintUrl,
      fee: result.operation.fee,
      proofCount: operation.inputProofs.length,
    });

    return result;
  }

  private async publishPrepared(result: PreparedReceiveResult): Promise<void> {
    await this.publishCommittedEvent('counter:updated', result.counter);
    await this.publishCommittedEvent('receive-op:prepared', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
    });
  }

  private async publishCommittedEvent<E extends keyof CoreEvents>(
    event: E,
    payload: CoreEvents[E],
  ): Promise<void> {
    try {
      await this.eventBus.emit(event, payload, { throwOnError: true });
    } catch (error) {
      this.logger?.error('Failed to publish committed Receive event', { event, error });
    }
  }

  /**
   * Execute the prepared operation.
   * Marks executing before mint interaction to ensure crash-safe recovery.
   */
  async execute(operation: PreparedReceiveOperation): Promise<FinalizedReceiveOperation> {
    const releaseLock = await this.acquireOperationLock(operation.id);
    let outcome: ReceiveExecutionOutcome | undefined;
    try {
      const current = await this.operationQueries.getById(operation.id);
      if (!current) {
        throw new Error(`Operation ${operation.id} not found`);
      }
      if (current.state !== 'prepared') {
        throw new Error(
          `Cannot execute operation in state '${current.state}'. Expected 'prepared'.`,
        );
      }

      outcome = await this.executePrepared(current as PreparedReceiveOperation);
    } finally {
      releaseLock();
    }

    if (!outcome) {
      throw new Error(`Receive operation ${operation.id} did not produce a result`);
    }
    if (outcome.status === 'FAILED') {
      await this.publishFailedExecution(outcome.result);
      throw outcome.error;
    }
    await this.publishAppliedResult(outcome.result);
    return outcome.result.operation;
  }

  private async executePrepared(
    operation: PreparedReceiveOperation,
  ): Promise<ReceiveExecutionOutcome> {
    if (!operation.outputData) {
      throw new Error('Missing output data for receive operation');
    }
    const begun = await this.transactions.beginExecution({
      operationId: operation.id,
      updatedAt: Date.now(),
    });
    return this.submitPersistedReceive(begun.operation, begun.request);
  }

  private async submitPersistedReceive(
    operation: ExecutingReceiveOperation,
    request: ReceiveTransportRequest,
    options: { failDefinitiveRejection?: boolean } = {},
  ): Promise<ReceiveExecutionOutcome> {
    const metadata = await this.loadMintMetadata(request.mintUrl);
    const remote = this.remote.open(metadata, request.unit);

    this.logger?.info('Receiving token', {
      operationId: operation.id,
      mintUrl: request.mintUrl,
      proofs: request.inputProofs.length,
      amount: operation.amount,
    });

    let received: Proof[];
    try {
      received = await remote.receive(request);
    } catch (error) {
      const rollbackReason = this.getRollbackReasonForReceiveFailure(error);
      if (
        !rollbackReason ||
        !(error instanceof MintOperationError) ||
        options.failDefinitiveRejection === false
      ) {
        throw error;
      }
      const failed = await this.transactions.failExecution({
        operationId: operation.id,
        updatedAt: Date.now(),
        error: rollbackReason,
      });
      return { status: 'FAILED', result: failed, error };
    }

    // Response mapping and local validation happen outside the repository transaction. If either
    // fails after submission, the durable executing request remains available to recovery.
    const proofs = mapProofToCoreProof(request.mintUrl, 'ready', received, {
      unit: request.unit,
      createdByOperationId: operation.id,
    });
    const applied = await this.transactions.applyResult({
      operationId: operation.id,
      updatedAt: Date.now(),
      proofs,
    });
    return { status: 'FINALIZED', result: applied };
  }

  private async publishAppliedResult(result: AppliedReceiveResult): Promise<void> {
    if (!result.committed) return;

    const proofsByKeyset = new Map<string, CoreEvents['proofs:saved']['proofs']>();
    for (const proof of result.savedProofs) {
      const group = proofsByKeyset.get(proof.id) ?? [];
      group.push(proof);
      proofsByKeyset.set(proof.id, group);
    }
    for (const [keysetId, proofs] of proofsByKeyset) {
      await this.publishCommittedEvent('proofs:saved', {
        mintUrl: result.operation.mintUrl,
        keysetId,
        proofs,
      });
    }
    await this.publishCommittedEvent('receive-op:finalized', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
    });
  }

  private async publishFailedExecution(result: FailedReceiveExecution): Promise<void> {
    if (!result.committed) return;
    await this.publishCommittedEvent('receive-op:rolled-back', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
    });
  }

  /**
   * High-level receive method that orchestrates init → prepare → execute.
   * This is the primary entry point used by WalletApi.
   */
  async receive(token: Token | string): Promise<void> {
    const initOp = await this.init(token);
    const preparedOp = await this.prepare(initOp);
    await this.execute(preparedOp);
  }

  /**
   * Finalize an executing operation (idempotent).
   * Used by recovery when outputs are already saved.
   */
  async finalize(operationId: string): Promise<void> {
    const preCheck = await this.operationQueries.getById(operationId);
    if (!preCheck) {
      throw new Error(`Operation ${operationId} not found`);
    }
    if (preCheck.state === 'finalized') {
      this.logger?.debug('Receive operation already finalized', { operationId });
      return;
    }
    if (preCheck.state === 'rolled_back') {
      this.logger?.debug('Receive operation rolled back, skipping finalization', { operationId });
      return;
    }

    const releaseLock = await this.acquireOperationLock(operationId);
    let result: AppliedReceiveResult | undefined;
    try {
      const operation = await this.operationQueries.getById(operationId);
      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
      }

      if (operation.state === 'finalized') {
        return;
      }
      if (operation.state === 'rolled_back') {
        return;
      }
      if (operation.state !== 'executing') {
        throw new Error(`Cannot finalize operation in state ${operation.state}`);
      }

      const executing = operation as ExecutingReceiveOperation;
      const savedOutputs = await this.getSavedOutputs(executing);
      if (!savedOutputs) {
        throw new Error('Cannot finalize receive operation: outputs not persisted');
      }
      result = await this.transactions.applyResult({
        operationId: executing.id,
        updatedAt: Date.now(),
        proofs: savedOutputs,
      });
    } finally {
      releaseLock();
    }
    if (result) await this.publishAppliedResult(result);
  }

  /**
   * Recover pending operations on startup.
   * Handles init cleanup, logs stale prepared operations, and recovers executing operations.
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

      const initOps = await this.operationQueries.getByState('init');
      for (const op of initOps) {
        let didRecover = false;
        try {
          const releaseLock = await this.acquireOperationLock(op.id);
          try {
            const current = await this.operationQueries.getById(op.id);
            if (current && current.state === 'init') {
              await this.recoverInitOperation(current as InitReceiveOperation);
              didRecover = true;
            }
          } finally {
            releaseLock();
          }
        } catch (e) {
          if (e instanceof OperationInProgressError) {
            this.logger?.debug('Init receive operation is in progress, skipping recovery', {
              operationId: op.id,
            });
            continue;
          }
          throw e;
        }
        if (didRecover) {
          initCount++;
        }
      }

      const preparedOps = await this.operationQueries.getByState('prepared');
      for (const op of preparedOps) {
        this.logger?.warn('Found stale prepared receive operation, user can rollback manually', {
          operationId: op.id,
        });
      }

      const executingOps = await this.operationQueries.getByState('executing');
      for (const op of executingOps) {
        let didRecover = false;
        try {
          const current = await this.operationQueries.getById(op.id);
          if (current && current.state === 'executing') {
            await this.recoverExecutingOperation(current as ExecutingReceiveOperation);
            didRecover = true;
          }
        } catch (e) {
          if (e instanceof OperationInProgressError) {
            this.logger?.debug('Executing receive operation is in progress, skipping recovery', {
              operationId: op.id,
            });
            continue;
          }
          this.logger?.error('Error recovering executing receive operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        if (didRecover) {
          executingCount++;
        }
      }

      this.logger?.info('Receive recovery completed', {
        initOperations: initCount,
        executingOperations: executingCount,
      });
    } finally {
      this.recoveryLock = null;
      releaseRecoveryLock!();
    }
  }

  /** Cleanup for failed init operations with no external side effects. */
  private async recoverInitOperation(op: InitReceiveOperation): Promise<void> {
    await this.transactions.deleteLegacyInit(op.id);
    this.logger?.info('Cleaned up failed receive init operation', { operationId: op.id });
  }

  /**
   * Recover an executing operation by checking mint state and restoring outputs.
   * Uses outputData to recover proofs if inputs were spent at the mint.
   */
  async recoverExecutingOperation(op: ExecutingReceiveOperation): Promise<void> {
    const releaseLock = await this.acquireOperationLock(op.id);
    let outcome: ReceiveExecutionOutcome | undefined;
    try {
      const current = await this.operationQueries.getById(op.id);
      if (!current) {
        this.logger?.warn('Receive operation missing during recovery', { operationId: op.id });
        return;
      }
      if (current.state === 'finalized' || current.state === 'rolled_back') {
        return;
      }
      if (current.state !== 'executing') {
        this.logger?.debug('Receive operation not executing during recovery', {
          operationId: current.id,
          state: current.state,
        });
        return;
      }

      const executing = current as ExecutingReceiveOperation;

      const savedOutputs = await this.getSavedOutputs(executing);
      if (savedOutputs) {
        const result = await this.transactions.applyResult({
          operationId: executing.id,
          updatedAt: Date.now(),
          proofs: savedOutputs,
        });
        outcome = { status: 'FINALIZED', result };
        this.logger?.info('Receive operation finalized during recovery (outputs already saved)', {
          operationId: executing.id,
        });
      } else {
        outcome = await this.recoverExecutingRequest(executing);
      }
    } finally {
      releaseLock();
    }
    if (outcome?.status === 'FINALIZED') {
      await this.publishAppliedResult(outcome.result);
    } else if (outcome?.status === 'FAILED') {
      await this.publishFailedExecution(outcome.result);
    }
  }

  private async recoverExecutingRequest(
    executing: ExecutingReceiveOperation,
  ): Promise<ReceiveExecutionOutcome | undefined> {
    let inputStates: CashuProofState[];
    try {
      inputStates = await this.checkProofStatesWithMint(
        executing.mintUrl,
        executing.unit,
        executing.inputProofs,
      );
    } catch {
      this.logger?.warn('Could not reach mint for receive recovery, will retry later', {
        operationId: executing.id,
        mintUrl: executing.mintUrl,
      });
      return;
    }

    if (inputStates.length !== executing.inputProofs.length) {
      this.logger?.warn('Receive operation input-state evidence is incomplete, retry later', {
        operationId: executing.id,
        expectedCount: executing.inputProofs.length,
        observedCount: inputStates.length,
      });
      return;
    }

    const allUnspent = inputStates.every((state) => state.state === 'UNSPENT');
    const allSpent = inputStates.every((state) => state.state === 'SPENT');
    if (allUnspent) {
      try {
        return await this.submitPersistedReceive(executing, this.toTransportRequest(executing), {
          failDefinitiveRejection: false,
        });
      } catch (error) {
        if (error instanceof MintOperationError) {
          try {
            const restored = await this.recoverFromRestore(
              executing,
              this.getRollbackReasonForReceiveFailure(error),
            );
            if (restored) return restored;
          } catch (restoreError) {
            this.logger?.warn('Restore after Receive replay rejection failed', {
              operationId: executing.id,
              mintUrl: executing.mintUrl,
              error: restoreError instanceof Error ? restoreError.message : String(restoreError),
            });
          }
        }
        this.logger?.warn('Receive re-execution failed, will retry later', {
          operationId: executing.id,
          mintUrl: executing.mintUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (!allSpent) {
      this.logger?.warn('Receive operation inputs not conclusively spent, retry later', {
        operationId: executing.id,
      });
      return;
    }

    try {
      return await this.recoverFromRestore(
        executing,
        'Recovered: input proofs spent without recoverable outputs',
      );
    } catch (error) {
      this.logger?.warn('Recovering receive outputs failed, will retry later', {
        operationId: executing.id,
        mintUrl: executing.mintUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  private async recoverFromRestore(
    executing: ExecutingReceiveOperation,
    definitiveFailure: string | null,
  ): Promise<ReceiveExecutionOutcome | undefined> {
    const metadata = await this.loadMintMetadata(executing.mintUrl);
    const observation = await this.remote
      .open(metadata, executing.unit)
      .observeRestore(executing.outputData);
    if (observation.status === 'complete-unspent' || observation.status === 'complete-spent') {
      const state = observation.status === 'complete-unspent' ? 'ready' : 'spent';
      const restored =
        observation.status === 'complete-unspent'
          ? observation.unspentProofs
          : observation.restoredProofs;
      const proofs = mapProofToCoreProof(executing.mintUrl, state, restored, {
        unit: executing.unit,
        createdByOperationId: executing.id,
      });
      const result = await this.transactions.applyResult({
        operationId: executing.id,
        updatedAt: Date.now(),
        proofs,
      });
      return { status: 'FINALIZED', result };
    }
    if (observation.status === 'none' && definitiveFailure) {
      const result = await this.transactions.failExecution({
        operationId: executing.id,
        updatedAt: Date.now(),
        error: definitiveFailure,
      });
      return {
        status: 'FAILED',
        result,
        error: new MintOperationError(11001, definitiveFailure),
      };
    }
    this.logger?.warn('Restore evidence for Receive remains inconclusive', {
      operationId: executing.id,
      mintUrl: executing.mintUrl,
      restoredCount: observation.restoredProofs.length,
      expectedCount: observation.expectedOutputCount,
    });
    return;
  }

  private toTransportRequest(executing: ExecutingReceiveOperation): ReceiveTransportRequest {
    return {
      mintUrl: executing.mintUrl,
      unit: executing.unit,
      inputProofs: executing.inputProofs,
      outputData: executing.outputData,
    };
  }

  private getRollbackReasonForReceiveFailure(error: unknown): string | null {
    if (error instanceof MintOperationError) {
      return NON_TERMINAL_RECEIVE_MINT_ERROR_CODES.has(error.code) ? null : error.message;
    }

    return null;
  }

  private async checkProofStatesWithMint(
    mintUrl: string,
    unit: string,
    proofs: Proof[],
  ): Promise<CashuProofState[]> {
    const metadata = await this.loadMintMetadata(mintUrl);
    return this.remote.open(metadata, unit).checkProofStates(proofs);
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

  /**
   * Check if any output proofs already exist locally.
   * Used to avoid unnecessary recovery work.
   */
  private async getSavedOutputs(op: PreparedOrLaterOperation) {
    const outputSecrets = getOutputProofSecrets(op);
    if (outputSecrets.length === 0) return null;

    const existingProofs = await this.proofQueries.getProofsBySecrets(op.mintUrl, outputSecrets);
    return existingProofs.length === new Set(outputSecrets).size ? existingProofs : null;
  }

  /** Extract and normalize mint URL from token, with validation. */
  private extractMintUrl(token: Token | string): string {
    try {
      const rawMintUrl = typeof token === 'string' ? getTokenMetadata(token).mint : token.mint;
      return normalizeMintUrl(rawMintUrl);
    } catch (err) {
      this.logger?.warn('Failed to decode token for receive', { err });
      throw new ProofValidationError('Invalid token');
    }
  }

  /**
   * Get an operation by ID.
   */
  async getOperation(operationId: string): Promise<ReceiveOperation | null> {
    return this.operationQueries.getById(operationId);
  }

  /**
   * Get all pending operations.
   */
  async getPendingOperations(): Promise<ReceiveOperation[]> {
    return this.operationQueries.getPending();
  }

  /**
   * Get all prepared operations.
   */
  async getPreparedOperations(): Promise<PreparedReceiveOperation[]> {
    const ops = await this.operationQueries.getByState('prepared');
    return ops.filter((op): op is PreparedReceiveOperation => op.state === 'prepared');
  }

  /**
   * Rollback a receive operation.
   * Only allowed for operations in 'init' or 'prepared' state.
   */
  async rollback(operationId: string, reason?: string): Promise<void> {
    const releaseLock = await this.acquireOperationLock(operationId);
    let result: FailedReceiveExecution | undefined;
    try {
      const operation = await this.operationQueries.getById(operationId);
      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
      }

      switch (operation.state) {
        case 'executing':
          throw new Error(`Cannot rollback operation in state ${operation.state}`);

        case 'finalized':
          throw new Error(`Cannot rollback operation in state ${operation.state}`);

        case 'rolled_back':
          throw new Error(`Cannot rollback operation in state ${operation.state}`);

        case 'init':
          await this.transactions.deleteLegacyInit(operation.id);
          this.logger?.info('Receive operation cancelled', {
            operationId,
            reason: reason ?? 'User cancelled receive operation',
          });
          return;

        case 'prepared':
          result = await this.transactions.cancelPrepared({
            operationId: operation.id,
            updatedAt: Date.now(),
            error: reason ?? 'User cancelled receive operation',
          });
          break;
        default:
          throw new Error(`Cannot rollback operation in unknown state`);
      }
    } finally {
      releaseLock();
    }
    if (result) await this.publishFailedExecution(result);
  }
}
