import {
  getTokenMetadata,
  sumProofs,
  type Proof,
  type ProofState as CashuProofState,
  type Token,
} from '@cashu/cashu-ts';

import {
  generateSubId,
  normalizeMintUrl,
  mapProofToCoreProof,
  deserializeOutputData,
  computeYHexForSecrets,
} from '../../utils';
import {
  UnknownMintError,
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
  RolledBackReceiveOperation,
} from './ReceiveOperation';
import type { Logger } from '../../logging/Logger';
import type { CoreEvents } from '../../events/types';
import type { EventBus } from '../../events/EventBus';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import type { TokenService } from '../../services/TokenService';
import type { WalletService } from '../../services/WalletService';
import type { SeedService } from '../../services/SeedService.ts';
import { createReceiveOperation, getOutputProofSecrets } from './ReceiveOperation';
import { OperationIdLock } from '../OperationIdLock';
import { MintScopedLock } from '../MintScopedLock';
import { DEFAULT_UNIT, normalizeUnit } from '../../amounts.ts';
import type { ReceiveTransactions } from '../../transactions/receive/ReceiveTransactions.ts';
import type {
  ReceiveOperationQueries,
  ReceiveProofQueries,
} from '../../transactions/receive/ReceiveOperationQueries.ts';
import type {
  AppliedReceiveResult,
  FailedReceiveExecution,
  PreparedReceiveResult,
  ReceiveTransportRequest,
} from '../../transactions/receive/TransactionalReceiveOperations.ts';

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
  proofQueries: ReceiveProofQueries;
  transactions: ReceiveTransactions;
  proofService: ProofService;
  mintService: MintService;
  walletService: WalletService;
  mintAdapter: MintAdapter;
  tokenService: TokenService;
  seedService: SeedService;
  eventBus: EventBus<CoreEvents>;
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
  private readonly proofQueries: ReceiveProofQueries;
  private readonly transactions: ReceiveTransactions;
  private readonly proofService: ProofService;
  private readonly mintService: MintService;
  private readonly walletService: WalletService;
  private readonly mintAdapter: MintAdapter;
  private readonly tokenService: TokenService;
  private readonly seedService: SeedService;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  /** In-memory lock to prevent concurrent operations on the same operation ID */
  private readonly operationIdLock = new OperationIdLock();
  /** Lock for the global recovery process */
  private recoveryLock: Promise<void> | null = null;
  /** In-memory lock to serialize deterministic-output derivation (counter) per mint */
  private readonly mintScopedLock: MintScopedLock;

  constructor(dependencies: ReceiveOperationServiceDependencies) {
    this.operationQueries = dependencies.operationQueries;
    this.proofQueries = dependencies.proofQueries;
    this.transactions = dependencies.transactions;
    this.proofService = dependencies.proofService;
    this.mintService = dependencies.mintService;
    this.walletService = dependencies.walletService;
    this.mintAdapter = dependencies.mintAdapter;
    this.tokenService = dependencies.tokenService;
    this.seedService = dependencies.seedService;
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
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    const decodedToken = await this.tokenService.decodeToken(token, mintUrl);
    const unit = normalizeUnit(decodedToken.unit, { defaultUnit: DEFAULT_UNIT });
    const proofs = decodedToken.proofs;

    const preparedProofs = await this.proofService.prepareProofsForReceiving(proofs);
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
      // Serialize per-mint so concurrent receives on the same keyset cannot read the
      // same NUT-13 counter and derive colliding deterministic outputs. Mirrors the
      // send/melt/mint services, which already hold this lock across counter usage.
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
    const { wallet, keys } = await this.walletService.getWalletWithActiveKeysetId(
      mintUrl,
      operation.unit,
    );
    const fee = wallet.getFeesForProofs(operation.inputProofs);

    if (operation.amount.lessThanOrEqual(fee)) {
      throw new ProofValidationError('Receive amount is not sufficient after fees');
    }

    const seed = await this.seedService.getSeed();
    const result = await this.transactions.prepare({
      operation: { ...operation, updatedAt: Date.now() },
      activeKeys: keys,
      seed,
      fee,
    });

    this.logger?.info('Receive operation prepared', {
      operationId: operation.id,
      mintUrl,
      fee,
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
      expectedRevision: operation.revision ?? 0,
      updatedAt: Date.now(),
    });
    return this.submitPersistedReceive(begun.operation, begun.request);
  }

  private async submitPersistedReceive(
    operation: ExecutingReceiveOperation,
    request: ReceiveTransportRequest,
  ): Promise<ReceiveExecutionOutcome> {
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
      request.mintUrl,
      request.unit,
    );
    const outputData = deserializeOutputData(request.outputData);

    this.logger?.info('Receiving token', {
      operationId: operation.id,
      mintUrl: request.mintUrl,
      proofs: request.inputProofs.length,
      amount: operation.amount,
    });

    let received: Proof[];
    try {
      received = await wallet.receive(
        { mint: request.mintUrl, proofs: request.inputProofs, unit: request.unit },
        undefined,
        { type: 'custom', data: outputData.keep },
      );
    } catch (error) {
      const rollbackReason = this.getRollbackReasonForReceiveFailure(error);
      if (!rollbackReason || !(error instanceof MintOperationError)) {
        throw error;
      }
      const failed = await this.transactions.failExecution({
        operationId: operation.id,
        expectedRevision: operation.revision ?? 0,
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
      expectedRevision: operation.revision ?? 0,
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

  /** Compatibility execution path retained only for Receive recovery until #455. */
  private async executeInternal(
    executing: ExecutingReceiveOperation,
  ): Promise<FinalizedReceiveOperation> {
    if (!executing.outputData) {
      throw new Error('Missing output data for receive operation');
    }

    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
      executing.mintUrl,
      executing.unit,
    );
    const outputData = deserializeOutputData(executing.outputData);

    this.logger?.info('Receiving token', {
      operationId: executing.id,
      mintUrl: executing.mintUrl,
      proofs: executing.inputProofs.length,
      amount: executing.amount,
    });

    const newProofs = await wallet.receive(
      { mint: executing.mintUrl, proofs: executing.inputProofs, unit: executing.unit },
      undefined,
      { type: 'custom', data: outputData.keep },
    );

    await this.proofService.saveProofs(
      executing.mintUrl,
      mapProofToCoreProof(executing.mintUrl, 'ready', newProofs, {
        unit: executing.unit,
        createdByOperationId: executing.id,
      }),
    );

    return await this.markAsFinalized(executing);
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
      const outputsSaved = await this.hasSavedOutputs(executing);
      if (!outputsSaved) {
        throw new Error('Cannot finalize receive operation: outputs not persisted');
      }

      await this.markAsFinalized(executing);
    } finally {
      releaseLock();
    }
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
  async recoverExecutingOperation(
    op: ExecutingReceiveOperation,
    options?: { skipLock?: boolean },
  ): Promise<void> {
    const releaseLock = options?.skipLock ? undefined : await this.acquireOperationLock(op.id);
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

      if (await this.hasSavedOutputs(executing)) {
        await this.markAsFinalized(executing);
        this.logger?.info('Receive operation finalized during recovery (outputs already saved)', {
          operationId: executing.id,
        });
        return;
      }

      let inputStates: CashuProofState[];
      try {
        inputStates = await this.checkProofStatesWithMint(executing.mintUrl, executing.inputProofs);
      } catch (e) {
        this.logger?.warn('Could not reach mint for receive recovery, will retry later', {
          operationId: executing.id,
          mintUrl: executing.mintUrl,
        });
        return; // Leave in executing state
      }

      const allUnspent = inputStates.every((s) => s.state === 'UNSPENT');
      const allSpent = inputStates.every((s) => s.state === 'SPENT');

      if (allUnspent) {
        if (!executing.outputData) {
          await this.markAsRolledBack(executing, 'Recovered: missing output data for receive');
          return;
        }

        try {
          await this.executeInternal(executing);
        } catch (e) {
          const rollbackReason = this.getRollbackReasonForReceiveFailure(e);
          if (rollbackReason) {
            await this.markAsRolledBack(executing, rollbackReason);
            return;
          }

          this.logger?.warn('Receive re-execution failed, will retry later', {
            operationId: executing.id,
            mintUrl: executing.mintUrl,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }

      if (!allSpent) {
        this.logger?.warn('Receive operation inputs not conclusively spent, retry later', {
          operationId: executing.id,
        });
        return;
      }

      if (!executing.outputData) {
        await this.markAsRolledBack(executing, 'Recovered: missing output data for receive');
        return;
      }

      try {
        const recovered = await this.proofService.recoverProofsFromOutputData(
          executing.mintUrl,
          executing.outputData,
          {
            unit: executing.unit,
            createdByOperationId: executing.id,
          },
        );
        const outputsSaved = await this.hasSavedOutputs(executing);
        if (outputsSaved) {
          await this.markAsFinalized(executing);
          return;
        }
        if (recovered.length === 0) {
          await this.markAsRolledBack(
            executing,
            'Recovered: input proofs spent without recoverable outputs',
          );
          return;
        }
        this.logger?.warn('Receive outputs not persisted after recovery attempt', {
          operationId: executing.id,
          mintUrl: executing.mintUrl,
          recoveredCount: recovered.length,
        });
      } catch (e) {
        const rollbackReason = this.getRollbackReasonForReceiveFailure(e);
        if (rollbackReason) {
          await this.markAsRolledBack(executing, rollbackReason);
          return;
        }

        this.logger?.warn('Recovering receive outputs failed, will retry later', {
          operationId: executing.id,
          mintUrl: executing.mintUrl,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      if (releaseLock) {
        releaseLock();
      }
    }
  }

  private getRollbackReasonForReceiveFailure(error: unknown): string | null {
    if (error instanceof MintOperationError) {
      return NON_TERMINAL_RECEIVE_MINT_ERROR_CODES.has(error.code) ? null : error.message;
    }

    return null;
  }

  private async checkProofStatesWithMint(
    mintUrl: string,
    proofs: Proof[],
  ): Promise<CashuProofState[]> {
    const batches: string[][] = [];
    let batchResults: CashuProofState[][] = [];

    const proofSecrets = proofs.map((p) => p.secret);
    const yHexes = computeYHexForSecrets(proofSecrets);

    // Using a batch of 100 Y values as checkProofStates only accepts 100 per request
    for (let i = 0; i < yHexes.length; i += 100) {
      batches.push(yHexes.slice(i, i + 100));
    }

    batchResults = await Promise.all(
      batches.map((batch) => this.mintAdapter.checkProofStates(mintUrl, batch)),
    );

    return batchResults.flat();
  }

  /**
   * Persist finalized state and emit the operation finalized event.
   */
  private async markAsFinalized(op: ExecutingReceiveOperation): Promise<FinalizedReceiveOperation> {
    const current = await this.operationQueries.getById(op.id);
    if (!current) {
      throw new Error(`Operation ${op.id} not found`);
    }
    if (current.state === 'finalized') {
      return current as FinalizedReceiveOperation;
    }
    if (current.state === 'rolled_back') {
      throw new Error(`Cannot finalize operation in state ${current.state}`);
    }
    if (current.state !== 'executing') {
      throw new Error(`Cannot finalize operation in state ${current.state}`);
    }

    const finalized: FinalizedReceiveOperation = {
      ...(current as ExecutingReceiveOperation),
      state: 'finalized',
      updatedAt: Date.now(),
    };
    await this.transactions.updateLegacyOperation(finalized);
    await this.eventBus.emit('receive-op:finalized', {
      mintUrl: finalized.mintUrl,
      operationId: finalized.id,
      operation: finalized,
    });

    this.logger?.info('Receive operation finalized', {
      operationId: finalized.id,
      mintUrl: finalized.mintUrl,
      proofCount: finalized.inputProofs.length,
    });

    return finalized;
  }

  /**
   * Persist rolled back state with error context.
   */
  private async markAsRolledBack(
    op: PreparedOrLaterOperation,
    error: string,
  ): Promise<RolledBackReceiveOperation> {
    const rolledBack: RolledBackReceiveOperation = {
      ...op,
      state: 'rolled_back',
      updatedAt: Date.now(),
      error,
    };
    await this.transactions.updateLegacyOperation(rolledBack);
    await this.eventBus.emit('receive-op:rolled-back', {
      mintUrl: rolledBack.mintUrl,
      operationId: rolledBack.id,
      operation: rolledBack,
    });

    this.logger?.info('Receive operation rolled back', {
      operationId: op.id,
      error,
    });

    return rolledBack;
  }

  /**
   * Check if any output proofs already exist locally.
   * Used to avoid unnecessary recovery work.
   */
  private async hasSavedOutputs(op: PreparedOrLaterOperation): Promise<boolean> {
    const outputSecrets = getOutputProofSecrets(op);
    if (outputSecrets.length === 0) return false;

    const existingProofs = await this.proofQueries.getProofsBySecrets(op.mintUrl, outputSecrets);
    return existingProofs.length === new Set(outputSecrets).size;
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
          await this.markAsRolledBack(
            operation as PreparedReceiveOperation,
            reason ?? 'User cancelled receive operation',
          );
          return;
        default:
          throw new Error(`Cannot rollback operation in unknown state`);
      }
    } finally {
      releaseLock();
    }
  }
}
