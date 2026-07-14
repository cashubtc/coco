import {
  getTokenMetadata,
  sumProofs,
  type Proof,
  type ProofState as CashuProofState,
  type Token,
  Amount,
} from '@cashu/cashu-ts';

import {
  generateSubId,
  normalizeMintUrl,
  mapProofToCoreProof,
  serializeOutputData,
  deserializeOutputData,
  computeYHexForSecrets,
  type SerializedOutputData,
} from '../../utils';
import {
  UnknownMintError,
  KeysetSyncError,
  MintFetchError,
  MintOperationError,
  NetworkError,
  ProofValidationError,
  OperationInProgressError,
} from '../../models/Error';
import type {
  ReceiveOperation,
  ReceiveOperationSource,
  InitReceiveOperation,
  PreparedReceiveOperation,
  PreparedOrLaterOperation,
  DeferredReceiveOperation,
  DeferredReceiveReason,
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
import { createReceiveOperation, getOutputProofSecrets } from './ReceiveOperation';
import { apportionReceiveFee } from './apportionFee';
import type { ReceiveOperationRepository, ProofRepository } from '../../repositories';
import { OperationIdLock } from '../OperationIdLock';
import { MintScopedLock } from '../MintScopedLock';
import { DEFAULT_UNIT, normalizeUnit } from '../../amounts.ts';

/** A deferred (or incoming init) operation participating in a batch redemption. */
interface BatchMember {
  operation: InitReceiveOperation | DeferredReceiveOperation;
  signedProofs: Proof[];
  /** Reason the member returns to the queue when the batch fails non-fatally. */
  requeueReason: DeferredReceiveReason;
  releaseLock: () => void;
}

const NON_TERMINAL_RECEIVE_MINT_ERROR_CODES = new Set([
  // 11003 is special for receive recovery: the mint may already have accepted and
  // signed our outputs even though the client saw an error, so we keep executing
  // and let recovery reconcile persisted outputs.
  //
  // We intentionally do not treat 11002/11004 as recoverable here. In the receive
  // flow they indicate inputs or outputs that are not currently spendable, so the
  // operation is rejected and a fresh receive should be started if the user retries.
  11003,
]);

/**
 * Service that manages receive operations as sagas.
 *
 * This service provides crash recovery and rollback capabilities for receive operations
 * By breaking them into discrete step:  init → prepare → execute → finalized
 * rolledback for failure state
 */
export class ReceiveOperationService {
  private readonly receiveOperationRepository: ReceiveOperationRepository;
  private readonly proofRepository: ProofRepository;
  private readonly proofService: ProofService;
  private readonly mintService: MintService;
  private readonly walletService: WalletService;
  private readonly mintAdapter: MintAdapter;
  private readonly tokenService: TokenService;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  /** In-memory lock to prevent concurrent operations on the same operation ID */
  private readonly operationIdLock = new OperationIdLock();
  /** Serializes batch redemption per mint */
  private readonly mintScopedLock = new MintScopedLock();
  /** Lock for the global recovery process */
  private recoveryLock: Promise<void> | null = null;
  /** In-memory lock to serialize deterministic-output derivation (counter) per mint */
  private readonly mintScopedLock: MintScopedLock;

  constructor(
    receiveOperationRepository: ReceiveOperationRepository,
    proofRepository: ProofRepository,
    proofService: ProofService,
    mintService: MintService,
    walletService: WalletService,
    mintAdapter: MintAdapter,
    tokenService: TokenService,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
    mintScopedLock?: MintScopedLock,
  ) {
    this.receiveOperationRepository = receiveOperationRepository;
    this.proofRepository = proofRepository;
    this.proofService = proofService;
    this.mintService = mintService;
    this.walletService = walletService;
    this.mintAdapter = mintAdapter;
    this.tokenService = tokenService;
    this.eventBus = eventBus;
    this.logger = logger;
    this.mintScopedLock = mintScopedLock ?? new MintScopedLock();
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
   * Persists the init state so recovery can reason about this operation.
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

    await this.receiveOperationRepository.create(operation);
    this.logger?.debug('Receive operation created', {
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
   * Transitions init -> deferred instead when the receive cannot be settled yet
   * (dust below the swap fee, or an unreachable mint).
   */
  async prepare(
    operation: InitReceiveOperation,
  ): Promise<PreparedReceiveOperation | DeferredReceiveOperation> {
    const releaseLock = await this.acquireOperationLock(operation.id);
    try {
      // Serialize per-mint so concurrent receives on the same keyset cannot read the
      // same NUT-13 counter and derive colliding deterministic outputs. Mirrors the
      // send/melt/mint services, which already hold this lock across counter usage.
      const releaseMintLock = await this.mintScopedLock.acquire(operation.mintUrl);
      let prepared: PreparedReceiveOperation;
      try {
        const current = await this.receiveOperationRepository.getById(operation.id);
        if (!current) {
          throw new Error(`Operation ${operation.id} not found`);
        }
        if (current.state !== 'init') {
          throw new Error(`Cannot prepare operation in state '${current.state}'. Expected 'init'.`);
        }

        try {
          prepared = await this.prepareInternal(current as InitReceiveOperation);
        } catch (e) {
          if (current.state === 'init') {
            await this.tryRecoverInitOperation(current as InitReceiveOperation);
          }
          throw e;
        }
      } finally {
        releaseMintLock();
      }

      // Emit outside the mint lock so a listener cannot extend or re-enter the
      // per-mint critical section. Mirrors the send service.
      await this.eventBus.emit('receive-op:prepared', {
        mintUrl: prepared.mintUrl,
        operationId: prepared.id,
        operation: prepared,
      });

      return prepared;
    } finally {
      releaseLock();
    }
  }

  /** Internal prepare logic used by prepare(), separated for error handling. */
  private async prepareInternal(
    operation: InitReceiveOperation,
  ): Promise<PreparedReceiveOperation | DeferredReceiveOperation> {
    if (!operation.inputProofs || operation.inputProofs.length === 0) {
      throw new ProofValidationError('Receive operation has no input proofs');
    }

    const { mintUrl } = operation;
    let wallet;
    try {
      ({ wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl, operation.unit));
    } catch (e) {
      if (this.isMintUnreachableError(e)) {
        return this.markAsDeferred(operation, 'mint-unreachable');
      }
      throw e;
    }
    const fee = wallet.getFeesForProofs(operation.inputProofs);

    if (operation.amount.lessThanOrEqual(fee)) {
      return this.markAsDeferred(operation, 'dust');
    }

    const keepAmount = operation.amount.subtract(fee);

    const outputResult = await this.proofService.createOutputsAndIncrementCounters(
      mintUrl,
      {
        keep: { amount: keepAmount, unit: operation.unit },
        send: { amount: Amount.zero(), unit: operation.unit },
      },
      {},
    );

    if (!outputResult.keep || outputResult.keep.length === 0) {
      throw new Error('Failed to create deterministic outputs for receive');
    }

    const outputData = serializeOutputData({ keep: outputResult.keep, send: [] });

    const prepared: PreparedReceiveOperation = {
      ...operation,
      state: 'prepared',
      updatedAt: Date.now(),
      fee,
      outputData,
    };

    await this.receiveOperationRepository.update(prepared);

    this.logger?.info('Receive operation prepared', {
      operationId: operation.id,
      mintUrl,
      fee,
      proofCount: operation.inputProofs.length,
    });

    return prepared;
  }

  /**
   * Execute the prepared operation.
   * Marks executing before mint interaction to ensure crash-safe recovery.
   */
  async execute(operation: PreparedReceiveOperation): Promise<FinalizedReceiveOperation> {
    const releaseLock = await this.acquireOperationLock(operation.id);
    try {
      const current = await this.receiveOperationRepository.getById(operation.id);
      if (!current) {
        throw new Error(`Operation ${operation.id} not found`);
      }
      if (current.state !== 'prepared') {
        throw new Error(
          `Cannot execute operation in state '${current.state}'. Expected 'prepared'.`,
        );
      }

      const prepared = current as PreparedReceiveOperation;
      const executing: ExecutingReceiveOperation = {
        ...prepared,
        state: 'executing',
        updatedAt: Date.now(),
      };
      await this.receiveOperationRepository.update(executing);

      try {
        return await this.executeInternal(executing);
      } catch (e) {
        const rollbackReason = this.getRollbackReasonForReceiveFailure(e);
        if (rollbackReason) {
          await this.markAsRolledBack(executing, rollbackReason);
          throw e;
        }

        await this.tryRecoverExecutingOperation(executing);
        throw e;
      }
    } finally {
      releaseLock();
    }
  }

  /** Internal execute logic used by execute(), separated for error handling. */
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
   * Returns the deferred operation when the receive cannot be settled yet.
   *
   * When deferred operations are already queued for the same mint and unit,
   * the incoming receive drains the queue: it settles together with them in
   * one batched swap (this is also how queued dust becomes redeemable).
   */
  async receive(
    token: Token | string,
  ): Promise<FinalizedReceiveOperation | DeferredReceiveOperation> {
    const initOp = await this.init(token);

    const hasQueuedGroupMembers = (
      await this.receiveOperationRepository.getByMintUrl(initOp.mintUrl)
    ).some((op) => op.state === 'deferred' && op.unit === initOp.unit);
    if (hasQueuedGroupMembers) {
      try {
        const batched = await this.redeemDeferredGroup(initOp.mintUrl, initOp.unit, initOp);
        if (batched) {
          return batched;
        }
      } catch (e) {
        // A failed batch must not fail a token that is receivable on its
        // own: fall back to the solo path when the operation is untouched,
        // or report it queued when the failure returned it to the queue.
        const current = await this.receiveOperationRepository.getById(initOp.id);
        if (current?.state === 'deferred') {
          return current;
        }
        if (!current || current.state !== 'init') {
          throw e;
        }
        this.logger?.warn('Batched receive failed, retrying solo', {
          operationId: initOp.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const preparedOp = await this.prepare(initOp);
    if (preparedOp.state === 'deferred') {
      return preparedOp;
    }
    return await this.execute(preparedOp);
  }

  /**
   * Finalize an executing operation (idempotent).
   * Used by recovery when outputs are already saved.
   */
  async finalize(operationId: string): Promise<void> {
    const preCheck = await this.receiveOperationRepository.getById(operationId);
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
      const operation = await this.receiveOperationRepository.getById(operationId);
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

      const initOps = await this.receiveOperationRepository.getByState('init');
      for (const op of initOps) {
        let didRecover = false;
        try {
          const releaseLock = await this.acquireOperationLock(op.id);
          try {
            const current = await this.receiveOperationRepository.getById(op.id);
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

      const preparedOps = await this.receiveOperationRepository.getByState('prepared');
      for (const op of preparedOps) {
        this.logger?.warn('Found stale prepared receive operation, user can rollback manually', {
          operationId: op.id,
        });
      }

      const executingOps = await this.receiveOperationRepository.getByState('executing');
      const soloOps = executingOps.filter((op) => !op.batchId);
      const batchGroups = new Map<string, ExecutingReceiveOperation[]>();
      for (const op of executingOps) {
        if (op.state === 'executing' && op.batchId) {
          const group = batchGroups.get(op.batchId) ?? [];
          group.push(op);
          batchGroups.set(op.batchId, group);
        }
      }

      for (const op of soloOps) {
        let didRecover = false;
        try {
          const current = await this.receiveOperationRepository.getById(op.id);
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

      for (const [batchId, group] of batchGroups) {
        try {
          await this.recoverBatchGroup(batchId, group);
          executingCount += group.length;
        } catch (e) {
          this.logger?.error('Error recovering batched receive operations', {
            batchId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Finally attempt to redeem whatever is queued; groups that are still
      // below the fee or unreachable simply stay deferred.
      await this.redeemDeferred();

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
    await this.receiveOperationRepository.delete(op.id);
    this.logger?.info('Cleaned up failed receive init operation', { operationId: op.id });
  }

  /** Init recovery when prepare fails. */
  private async tryRecoverInitOperation(op: InitReceiveOperation): Promise<void> {
    try {
      await this.recoverInitOperation(op);
      this.logger?.info('Recovered init receive operation after failure', { operationId: op.id });
    } catch (recoveryError) {
      this.logger?.warn('Failed to recover init receive operation, will retry on next startup', {
        operationId: op.id,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
    }
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
      const current = await this.receiveOperationRepository.getById(op.id);
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
        if (executing.batchId) {
          // A batch member must never be re-executed solo: its outputs were
          // built from a batch-wide fee apportionment and a solo swap would
          // not balance. The batch group recovery sweep re-executes it.
          this.logger?.debug('Batched receive member left for batch group recovery', {
            operationId: executing.id,
            batchId: executing.batchId,
          });
          return;
        }

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

      if (executing.batchId) {
        // Spent batch members settle individually from their own outputData;
        // zero-keep members finalize without any outputs to recover.
        await this.settleSpentBatchMember(
          executing,
          'Recovered: input proofs spent without recoverable outputs',
        );
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

  /** Best-effort executing recovery used when execute fails. */
  private async tryRecoverExecutingOperation(op: ExecutingReceiveOperation): Promise<void> {
    try {
      await this.recoverExecutingOperation(op, { skipLock: true });
      this.logger?.info('Recovered executing receive operation after failure', {
        operationId: op.id,
      });
    } catch (recoveryError) {
      this.logger?.warn('Failed to recover executing receive operation, will retry on startup', {
        operationId: op.id,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
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
    const current = await this.receiveOperationRepository.getById(op.id);
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
    await this.receiveOperationRepository.update(finalized);
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

  /** True for failures that indicate the mint could not be reached at all. */
  private isMintUnreachableError(error: unknown): boolean {
    return (
      error instanceof MintFetchError ||
      error instanceof KeysetSyncError ||
      error instanceof NetworkError
    );
  }

  /**
   * Persist deferred state and emit the operation deferred event.
   * Accepts executing operations so failed batch members can return to the queue;
   * prepared data and batch linkage are intentionally dropped in that case.
   */
  private async markAsDeferred(
    op: InitReceiveOperation | DeferredReceiveOperation | ExecutingReceiveOperation,
    deferredReason: DeferredReceiveReason,
  ): Promise<DeferredReceiveOperation> {
    const deferred: DeferredReceiveOperation = {
      id: op.id,
      state: 'deferred',
      deferredReason,
      mintUrl: op.mintUrl,
      unit: op.unit,
      amount: op.amount,
      inputProofs: op.inputProofs,
      createdAt: op.createdAt,
      updatedAt: Date.now(),
      error: op.error,
      source: op.source,
    };
    await this.receiveOperationRepository.update(deferred);
    await this.eventBus.emit('receive-op:deferred', {
      mintUrl: deferred.mintUrl,
      operationId: deferred.id,
      operation: deferred,
    });

    this.logger?.info('Receive operation deferred', {
      operationId: deferred.id,
      mintUrl: deferred.mintUrl,
      deferredReason,
      amount: deferred.amount,
      proofCount: deferred.inputProofs.length,
    });

    return deferred;
  }

  /**
   * Persist rolled back state with error context.
   * Accepts deferred operations (e.g. queued members whose inputs turn out
   * spent); they were never prepared, so an empty prepared payload is
   * persisted to satisfy the terminal row shape.
   */
  private async markAsRolledBack(
    op: PreparedOrLaterOperation | DeferredReceiveOperation,
    error: string,
  ): Promise<RolledBackReceiveOperation> {
    const rolledBack: RolledBackReceiveOperation =
      op.state === 'deferred'
        ? {
            id: op.id,
            state: 'rolled_back',
            mintUrl: op.mintUrl,
            unit: op.unit,
            amount: op.amount,
            inputProofs: op.inputProofs,
            createdAt: op.createdAt,
            updatedAt: Date.now(),
            error,
            source: op.source,
            fee: Amount.zero(),
            outputData: serializeOutputData({ keep: [], send: [] }),
          }
        : {
            ...op,
            state: 'rolled_back',
            updatedAt: Date.now(),
            error,
          };
    await this.receiveOperationRepository.update(rolledBack);
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

    const existingProofs = await this.proofRepository.getProofsBySecrets(op.mintUrl, outputSecrets);
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
    return this.receiveOperationRepository.getById(operationId);
  }

  /**
   * Get all pending operations.
   */
  async getPendingOperations(): Promise<ReceiveOperation[]> {
    return this.receiveOperationRepository.getPending();
  }

  /**
   * Get all prepared operations.
   */
  async getPreparedOperations(): Promise<PreparedReceiveOperation[]> {
    const ops = await this.receiveOperationRepository.getByState('prepared');
    return ops.filter((op): op is PreparedReceiveOperation => op.state === 'prepared');
  }

  /**
   * Get all deferred operations.
   */
  async getDeferredOperations(): Promise<DeferredReceiveOperation[]> {
    const ops = await this.receiveOperationRepository.getByState('deferred');
    return ops.filter((op): op is DeferredReceiveOperation => op.state === 'deferred');
  }

  /**
   * Attempt to redeem deferred operations, batched per mint and unit.
   *
   * Each viable group (combined amount above the combined fee) is settled with
   * ONE swap whose single fee is apportioned across the members; every member
   * still finalizes as its own operation with its own event and history entry.
   * Groups that stay below the combined fee remain deferred. Failures are
   * logged per group and never abort the sweep.
   */
  async redeemDeferred(filter?: { mintUrl?: string; unit?: string }): Promise<void> {
    const deferredOps = await this.getDeferredOperations();
    const groups = new Map<string, { mintUrl: string; unit: string }>();
    for (const op of deferredOps) {
      if (filter?.mintUrl && normalizeMintUrl(filter.mintUrl) !== op.mintUrl) continue;
      if (filter?.unit && normalizeUnit(filter.unit) !== op.unit) continue;
      groups.set(`${op.mintUrl}::${op.unit}`, { mintUrl: op.mintUrl, unit: op.unit });
    }

    for (const { mintUrl, unit } of groups.values()) {
      try {
        await this.redeemDeferredGroup(mintUrl, unit);
      } catch (e) {
        this.logger?.warn('Deferred receive redemption failed for group, will retry later', {
          mintUrl,
          unit,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  /**
   * Redeem the deferred operations of one (mintUrl, unit) group in a single
   * batched swap, optionally including an incoming init operation so a fresh
   * receive can drain the queue it batches with.
   *
   * Returns the incoming operation's outcome when one was provided (finalized,
   * or deferred when the group is still below the fee), or null when the
   * incoming operation could not be processed (caller falls back to the solo
   * path). Without an incoming operation the return value is null.
   */
  async redeemDeferredGroup(
    mintUrl: string,
    unit: string,
    incoming?: InitReceiveOperation,
  ): Promise<FinalizedReceiveOperation | DeferredReceiveOperation | null> {
    const releaseMintLock = await this.mintScopedLock.acquire(mintUrl);
    const members: BatchMember[] = [];
    try {
      const candidates = (await this.receiveOperationRepository.getByMintUrl(mintUrl))
        .filter((op): op is DeferredReceiveOperation => op.state === 'deferred')
        .filter((op) => op.unit === unit)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      for (const candidate of candidates) {
        const member = await this.collectBatchMember(candidate);
        if (member) {
          members.push(member);
        }
      }

      await this.dropUnredeemableBatchMembers(mintUrl, members);

      if (incoming) {
        const releaseLock = await this.acquireOperationLock(incoming.id);
        members.push({
          operation: incoming,
          signedProofs: incoming.inputProofs,
          requeueReason: 'dust',
          releaseLock,
        });
      }

      if (members.length === 0) {
        return null;
      }

      return await this.executeBatch(mintUrl, unit, members, incoming?.id);
    } finally {
      for (const member of members) {
        member.releaseLock();
      }
      releaseMintLock();
    }
  }

  /**
   * Validate queued members' inputs with the mint before batching. The batch
   * swap is atomic, so one already-spent input (e.g. a sender double-spent a
   * queued token) would fail redemption for every member on every attempt.
   * Members with spent inputs roll back terminally; members with pending
   * inputs stay queued but sit out this round. Best-effort: when the state
   * check itself fails, the batch proceeds and the swap outcome decides.
   * Dropped members are released and removed from `members` in place.
   */
  private async dropUnredeemableBatchMembers(
    mintUrl: string,
    members: BatchMember[],
  ): Promise<void> {
    const queued = members.filter((member) => member.operation.state === 'deferred');
    if (queued.length === 0) {
      return;
    }

    let states: CashuProofState[];
    try {
      states = await this.checkProofStatesWithMint(
        mintUrl,
        queued.flatMap((member) => member.signedProofs),
      );
    } catch {
      return;
    }
    const stateByY = new Map(states.map((state) => [state.Y, state.state]));

    for (const member of queued) {
      const yHexes = computeYHexForSecrets(member.signedProofs.map((proof) => proof.secret));
      const memberStates = yHexes.map((y) => stateByY.get(y));

      if (memberStates.some((state) => state === 'SPENT')) {
        if (member.operation.state === 'deferred') {
          await this.markAsRolledBack(member.operation, 'Receive inputs are already spent');
        }
      } else if (memberStates.some((state) => state === 'PENDING')) {
        this.logger?.debug('Queued receive inputs pending elsewhere, skipping this batch', {
          operationId: member.operation.id,
        });
      } else {
        continue;
      }

      member.releaseLock();
      members.splice(members.indexOf(member), 1);
    }
  }

  /**
   * Lock and validate one deferred operation for batch membership.
   * Returns null (member stays deferred) when it is busy or changed state.
   *
   * The isLocked check must stay non-blocking: prepare()/execute() acquire
   * their operation lock before any mint-scoped work, while the batch path
   * already holds the mint lock here — blocking on a busy operation would be
   * an ABBA deadlock between the two paths.
   */
  private async collectBatchMember(
    candidate: DeferredReceiveOperation,
  ): Promise<BatchMember | null> {
    if (this.operationIdLock.isLocked(candidate.id)) {
      return null;
    }
    const releaseLock = await this.acquireOperationLock(candidate.id);

    const current = await this.receiveOperationRepository.getById(candidate.id);
    if (!current || current.state !== 'deferred') {
      releaseLock();
      return null;
    }

    return {
      operation: current,
      signedProofs: current.inputProofs,
      requeueReason: current.deferredReason,
      releaseLock,
    };
  }

  /**
   * Execute one batched swap for the locked members: apportion the single fee,
   * create per-member outputs, swap once, then finalize each member.
   */
  private async executeBatch(
    mintUrl: string,
    unit: string,
    members: BatchMember[],
    incomingId?: string,
  ): Promise<FinalizedReceiveOperation | DeferredReceiveOperation | null> {
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl, unit);

    const allInputs = members.flatMap((member) => member.signedProofs);
    const totalAmount = Amount.sum(members.map((member) => member.operation.amount));
    const fee = wallet.getFeesForProofs(allInputs);

    if (totalAmount.lessThanOrEqual(fee)) {
      this.logger?.debug('Deferred receive group below combined fee, leaving queued', {
        mintUrl,
        unit,
        totalAmount,
        fee,
        memberCount: members.length,
      });
      const incoming = members.find((member) => member.operation.id === incomingId);
      if (incoming && incoming.operation.state === 'init') {
        return await this.markAsDeferred(incoming.operation, 'dust');
      }
      return null;
    }

    const shares = apportionReceiveFee(
      members.map((member) => ({ id: member.operation.id, amount: member.operation.amount })),
      fee,
    );

    const batchId = generateSubId();
    const executingMembers: ExecutingReceiveOperation[] = [];
    for (const member of members) {
      const share = shares.get(member.operation.id);
      if (!share) {
        throw new Error(`Missing fee share for batch member ${member.operation.id}`);
      }

      let outputData: SerializedOutputData;
      if (share.keepAmount.isZero()) {
        outputData = serializeOutputData({ keep: [], send: [] });
      } else {
        const outputResult = await this.proofService.createOutputsAndIncrementCounters(
          mintUrl,
          {
            keep: { amount: share.keepAmount, unit },
            send: { amount: Amount.zero(), unit },
          },
          {},
        );
        if (!outputResult.keep || outputResult.keep.length === 0) {
          throw new Error('Failed to create deterministic outputs for receive');
        }
        outputData = serializeOutputData({ keep: outputResult.keep, send: [] });
      }

      executingMembers.push({
        id: member.operation.id,
        state: 'executing',
        mintUrl,
        unit,
        amount: member.operation.amount,
        inputProofs: member.signedProofs,
        createdAt: member.operation.createdAt,
        updatedAt: Date.now(),
        error: member.operation.error,
        source: member.operation.source,
        fee: share.feeShare,
        outputData,
        batchId,
      });
    }

    for (const executing of executingMembers) {
      await this.receiveOperationRepository.update(executing);
    }

    this.logger?.info('Redeeming deferred receives in one batch', {
      mintUrl,
      unit,
      batchId,
      memberCount: executingMembers.length,
      totalAmount,
      fee,
    });

    try {
      const allKeepOutputs = executingMembers.flatMap(
        (executing) => deserializeOutputData(executing.outputData).keep,
      );
      const newProofs = await wallet.receive(
        { mint: mintUrl, proofs: allInputs, unit },
        undefined,
        {
          type: 'custom',
          data: allKeepOutputs,
        },
      );

      const finalized = await this.finalizeBatchMembers(mintUrl, unit, executingMembers, newProofs);
      return incomingId ? (finalized.get(incomingId) ?? null) : null;
    } catch (e) {
      await this.handleBatchFailure(mintUrl, members, executingMembers, e);
      throw e;
    }
  }

  /**
   * Split the proofs returned by a batched swap back to their members by
   * output secret, save them per member, and finalize each member.
   */
  private async finalizeBatchMembers(
    mintUrl: string,
    unit: string,
    executingMembers: ExecutingReceiveOperation[],
    newProofs: Proof[],
  ): Promise<Map<string, FinalizedReceiveOperation>> {
    const finalized = new Map<string, FinalizedReceiveOperation>();
    for (const executing of executingMembers) {
      const memberSecrets = new Set(getOutputProofSecrets(executing));
      const memberProofs = newProofs.filter((proof) => memberSecrets.has(proof.secret));
      if (memberProofs.length > 0) {
        await this.proofService.saveProofs(
          mintUrl,
          mapProofToCoreProof(mintUrl, 'ready', memberProofs, {
            unit,
            createdByOperationId: executing.id,
          }),
        );
      }
      finalized.set(executing.id, await this.markAsFinalized(executing));
    }
    return finalized;
  }

  /**
   * Settle a failed batch swap: on terminal mint errors each member is checked
   * against the mint (spent inputs settle or roll back individually, unspent
   * members return to the deferred queue so one poisoned member cannot wedge
   * it); transient failures keep members executing for crash recovery.
   */
  private async handleBatchFailure(
    mintUrl: string,
    members: BatchMember[],
    executingMembers: ExecutingReceiveOperation[],
    error: unknown,
  ): Promise<void> {
    const rollbackReason = this.getRollbackReasonForReceiveFailure(error);
    if (!rollbackReason) {
      this.logger?.warn('Batched receive swap failed transiently, members left executing', {
        mintUrl,
        batchId: executingMembers[0]?.batchId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const membersById = new Map(members.map((member) => [member.operation.id, member]));
    for (const executing of executingMembers) {
      try {
        const inputStates = await this.checkProofStatesWithMint(mintUrl, executing.inputProofs);
        const allSpent =
          inputStates.length > 0 && inputStates.every((state) => state.state === 'SPENT');
        const original = membersById.get(executing.id);
        if (allSpent) {
          await this.settleSpentBatchMember(executing, rollbackReason);
        } else if (original?.operation.state === 'init') {
          // A fresh receive only joined the batch opportunistically; restore
          // its init snapshot so receive() can retry it solo instead of
          // parking a token that is receivable on its own.
          await this.receiveOperationRepository.update({
            ...original.operation,
            updatedAt: Date.now(),
          });
        } else {
          await this.markAsDeferred(executing, original?.requeueReason ?? 'dust');
        }
      } catch (memberError) {
        this.logger?.warn('Could not settle batch member after failed swap, left executing', {
          operationId: executing.id,
          error: memberError instanceof Error ? memberError.message : String(memberError),
        });
      }
    }
  }

  /**
   * Settle a batch member whose inputs are spent at the mint: recover its own
   * outputs when possible, otherwise roll it back.
   */
  private async settleSpentBatchMember(
    executing: ExecutingReceiveOperation,
    rollbackReason: string,
  ): Promise<void> {
    const outputSecrets = getOutputProofSecrets(executing);
    if (outputSecrets.length === 0) {
      // Zero-keep member: its whole value was its fee share, nothing to recover.
      await this.markAsFinalized(executing);
      return;
    }

    await this.proofService.recoverProofsFromOutputData(executing.mintUrl, executing.outputData, {
      unit: executing.unit,
      createdByOperationId: executing.id,
    });
    if (await this.hasSavedOutputs(executing)) {
      await this.markAsFinalized(executing);
      return;
    }
    await this.markAsRolledBack(executing, rollbackReason);
  }

  /**
   * Recover the still-executing members of an interrupted batch redemption.
   *
   * The batch swap is atomic at the mint, so the members' input states decide
   * together: all spent means the swap happened (restore each member from its
   * own outputData), all unspent means it did not (re-execute the combined
   * swap from the stored per-member outputData). Members whose inputs diverge
   * (e.g. a sender double-spent queued dust) settle or return to the queue
   * individually.
   */
  private async recoverBatchGroup(
    batchId: string,
    group: ExecutingReceiveOperation[],
  ): Promise<void> {
    const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const releases: (() => void)[] = [];
    try {
      for (const op of sorted) {
        if (this.operationIdLock.isLocked(op.id)) {
          this.logger?.debug('Batch member busy, skipping batch recovery this round', {
            batchId,
            operationId: op.id,
          });
          return;
        }
        releases.push(await this.acquireOperationLock(op.id));
      }

      const members: ExecutingReceiveOperation[] = [];
      for (const op of sorted) {
        const current = await this.receiveOperationRepository.getById(op.id);
        if (current && current.state === 'executing' && current.batchId === batchId) {
          members.push(current as ExecutingReceiveOperation);
        }
      }
      if (members.length === 0) {
        return;
      }

      const pending: ExecutingReceiveOperation[] = [];
      for (const member of members) {
        if (getOutputProofSecrets(member).length > 0 && (await this.hasSavedOutputs(member))) {
          await this.markAsFinalized(member);
        } else {
          pending.push(member);
        }
      }
      if (pending.length === 0) {
        return;
      }

      const spent: ExecutingReceiveOperation[] = [];
      const unspent: ExecutingReceiveOperation[] = [];
      for (const member of pending) {
        let inputStates: CashuProofState[];
        try {
          inputStates = await this.checkProofStatesWithMint(member.mintUrl, member.inputProofs);
        } catch (e) {
          this.logger?.warn('Could not reach mint for batch recovery, will retry later', {
            batchId,
            operationId: member.id,
          });
          return;
        }
        const allSpent =
          inputStates.length > 0 && inputStates.every((state) => state.state === 'SPENT');
        const allUnspent = inputStates.every((state) => state.state === 'UNSPENT');
        if (allSpent) {
          spent.push(member);
        } else if (allUnspent) {
          unspent.push(member);
        } else {
          this.logger?.warn('Batch member inputs not conclusive, retry later', {
            batchId,
            operationId: member.id,
          });
          return;
        }
      }

      for (const member of spent) {
        await this.settleSpentBatchMember(
          member,
          'Recovered: batch inputs spent without recoverable outputs',
        );
      }

      if (unspent.length === 0) {
        return;
      }

      if (spent.length > 0) {
        // The swap can only have partially spent inputs when a third party
        // spent some member's inputs; the surviving members return to the
        // queue and get re-batched with a fresh fee.
        for (const member of unspent) {
          await this.markAsDeferred(member, 'dust');
        }
        return;
      }

      await this.reExecuteBatch(batchId, unspent);
    } finally {
      for (const release of releases) {
        release();
      }
    }
  }

  /**
   * Re-execute an interrupted batch swap from the stored per-member
   * outputData. The stored outputs still balance because the fee depends only
   * on the unchanged inputs.
   */
  private async reExecuteBatch(
    batchId: string,
    members: ExecutingReceiveOperation[],
  ): Promise<void> {
    const first = members[0];
    if (!first) {
      return;
    }
    const { mintUrl, unit } = first;
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl, unit);
    const allInputs = members.flatMap((member) => member.inputProofs);
    const allKeepOutputs = members.flatMap(
      (member) => deserializeOutputData(member.outputData).keep,
    );

    // The stored outputs only balance when every member of the original
    // apportionment is present and the keyset fee is unchanged. A crash
    // between persisting members can leave a subset whose outputs no longer
    // satisfy the swap equation; requeue instead of trusting the mint to
    // reject the unbalanced swap.
    const fee = wallet.getFeesForProofs(allInputs);
    const outputTotal = Amount.sum(allKeepOutputs.map((output) => output.blindedMessage.amount));
    if (!outputTotal.add(fee).equals(sumProofs(allInputs))) {
      this.logger?.warn('Interrupted batch outputs do not balance, requeueing members', {
        mintUrl,
        batchId,
        memberCount: members.length,
        outputTotal,
        fee,
      });
      for (const member of members) {
        await this.markAsDeferred(member, 'dust');
      }
      return;
    }

    this.logger?.info('Re-executing interrupted batched receive', {
      mintUrl,
      batchId,
      memberCount: members.length,
    });

    try {
      const newProofs = await wallet.receive(
        { mint: mintUrl, proofs: allInputs, unit },
        undefined,
        {
          type: 'custom',
          data: allKeepOutputs,
        },
      );
      await this.finalizeBatchMembers(mintUrl, unit, members, newProofs);
    } catch (e) {
      const rollbackReason = this.getRollbackReasonForReceiveFailure(e);
      if (!rollbackReason) {
        this.logger?.warn('Batch re-execution failed transiently, will retry later', {
          batchId,
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      // A terminal failure (e.g. keyset fees changed while interrupted) sends
      // the members back to the queue; the next round re-batches with fresh
      // fees and outputs.
      for (const member of members) {
        await this.markAsDeferred(member, 'dust');
      }
    }
  }

  /**
   * Rollback a receive operation.
   * Only allowed for operations in 'init' or 'prepared' state.
   */
  async rollback(operationId: string, reason?: string): Promise<void> {
    const releaseLock = await this.acquireOperationLock(operationId);
    try {
      const operation = await this.receiveOperationRepository.getById(operationId);
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
        case 'deferred':
          await this.receiveOperationRepository.delete(operation.id);
          this.logger?.info('Receive operation cancelled', {
            operationId,
            state: operation.state,
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
