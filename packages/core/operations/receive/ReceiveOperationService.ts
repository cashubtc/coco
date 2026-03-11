import {
  getDecodedToken,
  getTokenMetadata,
  type Proof,
  type ProofState as CashuProofState,
  type Token,
} from '@cashu/cashu-ts';

import {
  generateSubId,
  normalizeMintUrl,
  mapProofToCoreProof,
  serializeOutputData,
  deserializeOutputData,
  computeYHexForSecrets,
} from '../../utils';
import {
  UnknownMintError,
  ProofValidationError,
  OperationInProgressError,
} from '../../models/Error';
import type {
  ReceiveOperation,
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
import { createReceiveOperation, getOutputProofSecrets } from './ReceiveOperation';
import type { ReceiveOperationRepository, ProofRepository } from '../../repositories';
import { OperationIdLock } from '../OperationIdLock';

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
  /** Lock for the global recovery process */
  private recoveryLock: Promise<void> | null = null;

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
  async init(token: Token | string): Promise<InitReceiveOperation> {
    const mintUrl = this.extractMintUrl(token);
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    const proofs = (await this.tokenService.decodeToken(token, mintUrl)).proofs;

    const preparedProofs = await this.proofService.prepareProofsForReceiving(proofs);
    if (!Array.isArray(preparedProofs) || preparedProofs.length === 0) {
      this.logger?.warn('Token contains no proofs', { mintUrl });
      throw new ProofValidationError('Token contains no proofs');
    }

    const amount = preparedProofs.reduce((acc, proof) => acc + proof.amount, 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      this.logger?.warn('Token has invalid or non-positive amount', { mintUrl, amount });
      throw new ProofValidationError('Token amount must be a positive integer');
    }

    const id = generateSubId();
    const operation = createReceiveOperation(id, mintUrl, amount, preparedProofs);

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
   */
  async prepare(operation: InitReceiveOperation): Promise<PreparedReceiveOperation> {
    const releaseLock = await this.acquireOperationLock(operation.id);
    try {
      const current = await this.receiveOperationRepository.getById(operation.id);
      if (!current) {
        throw new Error(`Operation ${operation.id} not found`);
      }
      if (current.state !== 'init') {
        throw new Error(`Cannot prepare operation in state '${current.state}'. Expected 'init'.`);
      }

      try {
        return await this.prepareInternal(current as InitReceiveOperation);
      } catch (e) {
        if (current.state === 'init') {
          await this.tryRecoverInitOperation(current as InitReceiveOperation);
        }
        throw e;
      }
    } finally {
      releaseLock();
    }
  }

  /** Internal prepare logic used by prepare(), separated for error handling. */
  private async prepareInternal(
    operation: InitReceiveOperation,
  ): Promise<PreparedReceiveOperation> {
    if (!operation.inputProofs || operation.inputProofs.length === 0) {
      throw new ProofValidationError('Receive operation has no input proofs');
    }

    const { mintUrl } = operation;
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const fee = wallet.getFeesForProofs(operation.inputProofs);
    const keepAmount = operation.amount - fee;

    if (!Number.isFinite(keepAmount) || keepAmount <= 0) {
      throw new ProofValidationError('Receive amount is not sufficient after fees');
    }

    const outputResult = await this.proofService.createOutputsAndIncrementCounters(mintUrl, {
      keep: keepAmount,
      send: 0,
    });

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

    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(executing.mintUrl);
    const outputData = deserializeOutputData(executing.outputData);

    this.logger?.info('Receiving token', {
      operationId: executing.id,
      mintUrl: executing.mintUrl,
      proofs: executing.inputProofs.length,
      amount: executing.amount,
    });

    const newProofs = await wallet.receive(
      { mint: executing.mintUrl, proofs: executing.inputProofs, unit: wallet.unit },
      undefined,
      { type: 'custom', data: outputData.keep },
    );

    await this.proofService.saveProofs(
      executing.mintUrl,
      mapProofToCoreProof(executing.mintUrl, 'ready', newProofs, {
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
      for (const op of executingOps) {
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
        if (!executing.outputData) {
          await this.markAsRolledBack(executing, 'Recovered: missing output data for receive');
          return;
        }

        try {
          await this.executeInternal(executing);
        } catch (e) {
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
            createdByOperationId: executing.id,
          },
        );
        const outputsSaved = await this.hasSavedOutputs(executing);
        if (outputsSaved) {
          await this.markAsFinalized(executing);
          return;
        }
        this.logger?.warn('Receive outputs not persisted after recovery attempt', {
          operationId: executing.id,
          mintUrl: executing.mintUrl,
          recoveredCount: recovered.length,
        });
      } catch (e) {
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
   * Persist finalized state and emit receive event for history updates.
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

    const executing = current as ExecutingReceiveOperation;
    await this.eventBus.emit('receive:created', {
      mintUrl: executing.mintUrl,
      token: { mint: executing.mintUrl, proofs: executing.inputProofs },
    });

    this.logger?.info('Receive operation finalized', {
      operationId: executing.id,
      mintUrl: executing.mintUrl,
      proofCount: executing.inputProofs.length,
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
    await this.receiveOperationRepository.update(rolledBack);

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

    for (const secret of outputSecrets) {
      const existing = await this.proofRepository.getProofBySecret(op.mintUrl, secret);
      if (!existing) {
        return false;
      }
    }

    return true;
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
          await this.receiveOperationRepository.delete(operation.id);
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
