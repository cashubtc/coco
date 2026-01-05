import { type Token, type Proof, type ProofState as CashuProofState } from '@cashu/cashu-ts';
import type { SendOperationRepository, ProofRepository } from '../../repositories';
import type {
  SendOperation,
  InitSendOperation,
  PreparedSendOperation,
  ExecutingSendOperation,
  PendingSendOperation,
  FinalizedSendOperation,
  RollingBackSendOperation,
  RolledBackSendOperation,
  PreparedOrLaterOperation,
} from './SendOperation';
import {
  createSendOperation,
  hasPreparedData,
  getSendProofSecrets,
  getKeepProofSecrets,
  isTerminalOperation,
} from './SendOperation';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import {
  generateSubId,
  mapProofToCoreProof,
  serializeOutputData,
  deserializeOutputData,
  getSecretsFromSerializedOutputData,
} from '../../utils';
import { UnknownMintError, ProofValidationError } from '../../models/Error';

/**
 * Service that manages send operations as sagas.
 *
 * This service provides crash recovery and rollback capabilities for send operations
 * by breaking them into discrete steps: init → prepare → execute → finalize/rollback.
 */
export class SendOperationService {
  private readonly sendOperationRepository: SendOperationRepository;
  private readonly proofRepository: ProofRepository;
  private readonly proofService: ProofService;
  private readonly mintService: MintService;
  private readonly walletService: WalletService;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  /** In-memory locks to prevent concurrent operations on the same operation ID */
  private readonly operationLocks: Map<string, Promise<void>> = new Map();
  /** Lock for the global recovery process */
  private recoveryLock: Promise<void> | null = null;

  constructor(
    sendOperationRepository: SendOperationRepository,
    proofRepository: ProofRepository,
    proofService: ProofService,
    mintService: MintService,
    walletService: WalletService,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.sendOperationRepository = sendOperationRepository;
    this.proofRepository = proofRepository;
    this.proofService = proofService;
    this.mintService = mintService;
    this.walletService = walletService;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  /**
   * Acquire a lock for an operation.
   * Returns a release function that must be called when the operation completes.
   * Throws if the operation is already locked.
   */
  private async acquireOperationLock(operationId: string): Promise<() => void> {
    const existingLock = this.operationLocks.get(operationId);
    if (existingLock) {
      throw new Error(`Operation ${operationId} is already in progress`);
    }

    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.operationLocks.set(operationId, lockPromise);

    return () => {
      this.operationLocks.delete(operationId);
      releaseLock!();
    };
  }

  /**
   * Check if an operation is currently locked.
   */
  isOperationLocked(operationId: string): boolean {
    return this.operationLocks.has(operationId);
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
  async init(mintUrl: string, amount: number): Promise<InitSendOperation> {
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ProofValidationError('Amount must be a positive number');
    }

    const id = generateSubId();
    const operation = createSendOperation(id, mintUrl, amount);

    await this.sendOperationRepository.create(operation);
    this.logger?.debug('Send operation created', { operationId: id, mintUrl, amount });

    return operation;
  }

  /**
   * Prepare the operation by reserving proofs and creating outputs.
   * After this step, the operation can be executed or rolled back.
   *
   * If preparation fails, automatically attempts to recover the init operation.
   * Throws if the operation is already in progress.
   */
  async prepare(operation: InitSendOperation): Promise<PreparedSendOperation> {
    const releaseLock = await this.acquireOperationLock(operation.id);
    try {
      return await this.prepareInternal(operation);
    } catch (e) {
      // Attempt to clean up the init operation before re-throwing
      await this.tryRecoverInitOperation(operation);
      throw e;
    } finally {
      releaseLock();
    }
  }

  /**
   * Internal prepare logic, separated for error handling.
   */
  private async prepareInternal(operation: InitSendOperation): Promise<PreparedSendOperation> {
    const { mintUrl, amount } = operation;
    const { wallet, keys } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);

    // Get available proofs (ready and not reserved by other operations)
    const availableProofs = await this.proofRepository.getAvailableProofs(mintUrl);
    const totalAvailable = availableProofs.reduce((acc, p) => acc + p.amount, 0);

    if (totalAvailable < amount) {
      throw new ProofValidationError(
        `Insufficient balance: need ${amount}, have ${totalAvailable}`,
      );
    }

    // Try exact match first (no swap needed)
    const exactProofs = wallet.selectProofsToSend(availableProofs, amount, false);
    const exactAmount = exactProofs.send.reduce((acc, p) => acc + p.amount, 0);
    const needsSwap = exactAmount !== amount || exactProofs.send.length === 0;

    let selectedProofs: Proof[];
    let fee = 0;
    let serializedOutputData: PreparedSendOperation['outputData'];

    if (!needsSwap && exactProofs.send.length > 0) {
      // Exact match - no swap needed, no OutputData
      selectedProofs = exactProofs.send;
      this.logger?.debug('Exact match found for send', {
        operationId: operation.id,
        amount,
        proofCount: selectedProofs.length,
      });
    } else {
      // Need to swap - select proofs including fees
      const selected = wallet.selectProofsToSend(availableProofs, amount, true);
      selectedProofs = selected.send;
      const selectedAmount = selectedProofs.reduce((acc, p) => acc + p.amount, 0);
      fee = wallet.getFeesForProofs(selectedProofs);
      const keepAmount = selectedAmount - amount - fee;

      // Use ProofService to create outputs and increment counters
      const outputResult = await this.proofService.createOutputsAndIncrementCounters(mintUrl, {
        keep: keepAmount,
        send: amount,
      });

      // Serialize for storage
      serializedOutputData = serializeOutputData({
        keep: outputResult.keep,
        send: outputResult.send,
      });

      this.logger?.debug('Swap required for send', {
        operationId: operation.id,
        amount,
        fee,
        keepAmount,
        selectedAmount,
        proofCount: selectedProofs.length,
        keepOutputs: outputResult.keep.length,
        sendOutputs: outputResult.send.length,
      });
    }

    // Reserve the selected proofs
    const inputSecrets = selectedProofs.map((p) => p.secret);
    await this.proofService.reserveProofs(mintUrl, inputSecrets, operation.id);

    // Build prepared operation
    const prepared: PreparedSendOperation = {
      id: operation.id,
      state: 'prepared',
      mintUrl: operation.mintUrl,
      amount: operation.amount,
      createdAt: operation.createdAt,
      updatedAt: Date.now(),
      error: operation.error,
      needsSwap,
      fee,
      inputAmount: selectedProofs.reduce((acc, p) => acc + p.amount, 0),
      inputProofSecrets: inputSecrets,
      outputData: serializedOutputData,
    };

    await this.sendOperationRepository.update(prepared);

    // Emit prepared event
    await this.eventBus.emit('send:prepared', {
      mintUrl,
      operationId: prepared.id,
      operation: prepared,
    });

    this.logger?.info('Send operation prepared', {
      operationId: operation.id,
      needsSwap,
      fee,
      inputProofCount: inputSecrets.length,
    });

    return prepared;
  }

  /**
   * Execute the prepared operation.
   * Performs the swap (if needed) and creates the token.
   *
   * If execution fails after transitioning to 'executing' state,
   * automatically attempts to recover the operation.
   * Throws if the operation is already in progress.
   */
  async execute(
    operation: PreparedSendOperation,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    const releaseLock = await this.acquireOperationLock(operation.id);
    try {
      // Mark as executing FIRST - this must happen before any mint interaction
      const executing: ExecutingSendOperation = {
        ...operation,
        state: 'executing',
        updatedAt: Date.now(),
      };
      await this.sendOperationRepository.update(executing);

      try {
        return await this.executeInternal(executing);
      } catch (e) {
        // Attempt to recover the executing operation before re-throwing
        await this.tryRecoverExecutingOperation(executing);
        throw e;
      }
    } finally {
      releaseLock();
    }
  }

  /**
   * Internal execute logic, separated for error handling.
   */
  private async executeInternal(
    executing: ExecutingSendOperation,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    const { mintUrl, amount, needsSwap, inputProofSecrets } = executing;

    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);

    // Get the reserved proofs
    const reservedProofs = await this.proofRepository.getProofsByOperationId(mintUrl, executing.id);
    const inputProofs = reservedProofs.filter((p) => inputProofSecrets.includes(p.secret));

    if (inputProofs.length !== inputProofSecrets.length) {
      throw new Error('Could not find all reserved proofs');
    }

    let sendProofs: Proof[];
    let keepProofs: Proof[] = [];

    if (!needsSwap) {
      // Exact match - just use the proofs directly
      sendProofs = inputProofs;
      this.logger?.debug('Executing exact match send', {
        operationId: executing.id,
        proofCount: sendProofs.length,
      });

      // Mark send proofs as inflight
      const sendSecrets = sendProofs.map((p) => p.secret);
      await this.proofService.setProofState(mintUrl, sendSecrets, 'inflight');
    } else {
      // Perform swap using stored OutputData
      if (!executing.outputData) {
        throw new Error('Missing output data for swap operation');
      }

      // Deserialize OutputData
      const outputData = deserializeOutputData(executing.outputData);

      this.logger?.debug('Executing swap', {
        operationId: executing.id,
        keepOutputs: outputData.keep.length,
        sendOutputs: outputData.send.length,
      });

      // Perform the swap with the mint
      const result = await wallet.send(amount, inputProofs, { outputData });
      sendProofs = result.send;
      keepProofs = result.keep;

      // Save new proofs with correct states and operationId in a single call
      const keepCoreProofs = mapProofToCoreProof(mintUrl, 'ready', keepProofs, {
        createdByOperationId: executing.id,
      });
      const sendCoreProofs = mapProofToCoreProof(mintUrl, 'inflight', sendProofs, {
        createdByOperationId: executing.id,
      });
      await this.proofService.saveProofs(mintUrl, [...keepCoreProofs, ...sendCoreProofs]);

      // Mark input proofs as spent (use proofService to emit events)
      await this.proofService.setProofState(mintUrl, inputProofSecrets, 'spent');
    }

    // Build pending operation
    const pending: PendingSendOperation = {
      ...executing,
      state: 'pending',
      updatedAt: Date.now(),
    };
    await this.sendOperationRepository.update(pending);

    const token: Token = {
      mint: mintUrl,
      proofs: sendProofs,
    };

    // Emit pending event
    await this.eventBus.emit('send:pending', {
      mintUrl,
      operationId: pending.id,
      operation: pending,
      token,
    });

    this.logger?.info('Send operation executed', {
      operationId: executing.id,
      sendProofCount: sendProofs.length,
      keepProofCount: keepProofs.length,
    });

    return { operation: pending, token };
  }

  /**
   * High-level send method that orchestrates init → prepare → execute.
   * This is the main entry point for consumers.
   */
  async send(mintUrl: string, amount: number): Promise<Token> {
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
    // Check terminal states before acquiring lock to allow idempotent calls
    const preCheck = await this.sendOperationRepository.getById(operationId);
    if (!preCheck) {
      throw new Error(`Operation ${operationId} not found`);
    }
    if (preCheck.state === 'finalized') {
      this.logger?.debug('Operation already finalized', { operationId });
      return;
    }
    if (preCheck.state === 'rolled_back' || preCheck.state === 'rolling_back') {
      this.logger?.debug('Operation was rolled back or is rolling back, skipping finalization', {
        operationId,
      });
      return;
    }

    const releaseLock = await this.acquireOperationLock(operationId);
    try {
      // Re-fetch after acquiring lock to ensure state hasn't changed
      const operation = await this.sendOperationRepository.getById(operationId);
      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
      }

      // Handle terminal states gracefully to avoid race conditions with rollback
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

      // TypeScript knows operation is PendingSendOperation
      const pendingOp = operation as PendingSendOperation;

      const finalized: FinalizedSendOperation = {
        ...pendingOp,
        state: 'finalized',
        updatedAt: Date.now(),
      };
      await this.sendOperationRepository.update(finalized);

      // Release proof reservations (they're already spent)
      // Derive secrets from operation data
      const sendSecrets = getSendProofSecrets(pendingOp);
      const keepSecrets = getKeepProofSecrets(pendingOp);

      await this.proofService.releaseProofs(pendingOp.mintUrl, pendingOp.inputProofSecrets);
      if (sendSecrets.length > 0) {
        await this.proofService.releaseProofs(pendingOp.mintUrl, sendSecrets);
      }
      if (keepSecrets.length > 0) {
        await this.proofService.releaseProofs(pendingOp.mintUrl, keepSecrets);
      }

      await this.eventBus.emit('send:finalized', {
        mintUrl: pendingOp.mintUrl,
        operationId,
        operation: finalized,
      });

      this.logger?.info('Send operation finalized', { operationId });
    } finally {
      releaseLock();
    }
  }

  /**
   * Rollback an operation by reclaiming the proofs.
   * Only works for operations in 'prepared', 'executing', or 'pending' state.
   * Throws if the operation is already in progress.
   */
  async rollback(operationId: string): Promise<void> {
    const releaseLock = await this.acquireOperationLock(operationId);
    try {
      const operation = await this.sendOperationRepository.getById(operationId);
      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
      }

      if (
        operation.state === 'finalized' ||
        operation.state === 'rolled_back' ||
        operation.state === 'rolling_back' ||
        operation.state === 'executing' ||
        operation.state === 'init'
      ) {
        throw new Error(`Cannot rollback operation in state ${operation.state}`);
      }

      // At this point, operation has PreparedData
      if (!hasPreparedData(operation)) {
        throw new Error(`Operation ${operationId} is not in a rollbackable state`);
      }

      const { mintUrl, inputProofSecrets } = operation;

      if (operation.state === 'prepared') {
        // Simple case: just release the reserved proofs - no swap was done yet
        await this.proofService.releaseProofs(mintUrl, inputProofSecrets);
        this.logger?.info('Rolling back prepared/executing operation - released reserved proofs', {
          operationId,
        });
      } else if (operation.state === 'pending') {
        // Complex case: need to reclaim the send proofs by swapping them back.
        // Mark as 'rolling_back' BEFORE doing the swap to prevent race condition with ProofStateWatcher.
        // When we reclaim proofs via swap, the mint sends a SPENT notification which triggers
        // the watcher to try to finalize. By updating state first, the watcher will see
        // 'rolling_back' and skip finalization.
        const rollingBack: RollingBackSendOperation = {
          ...operation,
          state: 'rolling_back',
          updatedAt: Date.now(),
        };
        await this.sendOperationRepository.update(rollingBack);

        const sendSecrets = getSendProofSecrets(operation);

        if (sendSecrets.length > 0) {
          const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);

          // Get the send proofs
          const allProofs = await this.proofRepository.getProofsByOperationId(mintUrl, operationId);
          const sendProofs = allProofs.filter(
            (p) => sendSecrets.includes(p.secret) && p.state === 'inflight',
          );

          if (sendProofs.length > 0) {
            const totalAmount = sendProofs.reduce((acc, p) => acc + p.amount, 0);
            const fee = wallet.getFeesForProofs(sendProofs);
            const reclaimAmount = totalAmount - fee;

            if (reclaimAmount > 0) {
              // Use ProofService to create outputs for reclaim
              const outputResult = await this.proofService.createOutputsAndIncrementCounters(
                mintUrl,
                { keep: reclaimAmount, send: 0 },
              );

              // Swap to reclaim
              const { keep } = await wallet.send(reclaimAmount, sendProofs, {
                outputData: { keep: outputResult.keep, send: [] },
              });

              // Save reclaimed proofs
              await this.proofService.saveProofs(
                mintUrl,
                mapProofToCoreProof(mintUrl, 'ready', keep),
              );

              // Mark send proofs as spent
              await this.proofService.setProofState(
                mintUrl,
                sendProofs.map((p) => p.secret),
                'spent',
              );

              this.logger?.info('Reclaimed proofs from pending operation', {
                operationId,
                reclaimedAmount: reclaimAmount,
                proofCount: keep.length,
              });
            }
          }
        }

        // Release any remaining reservations
        await this.proofService.releaseProofs(mintUrl, inputProofSecrets);
        const keepSecrets = getKeepProofSecrets(operation);
        if (keepSecrets.length > 0) {
          await this.proofService.releaseProofs(mintUrl, keepSecrets);
        }
      }

      await this.markAsRolledBack(operation, 'Rolled back by user action');
    } finally {
      releaseLock();
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
      const initOps = await this.sendOperationRepository.getByState('init');
      for (const op of initOps) {
        await this.recoverInitOperation(op as InitSendOperation);
        initCount++;
      }

      // 2. Log warnings for prepared operations (leave for user to decide)
      const preparedOps = await this.sendOperationRepository.getByState('prepared');
      for (const op of preparedOps) {
        this.logger?.warn('Found stale prepared operation, user can rollback manually', {
          operationId: op.id,
        });
      }

      // 3. Recover executing operations
      const executingOps = await this.sendOperationRepository.getByState('executing');
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
      const pendingOps = await this.sendOperationRepository.getByState('pending');
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
      // This requires storing the reclaim OutputData before the swap so we can
      // recover proofs via the mint's restore endpoint if the swap succeeded
      // but we crashed before saving the reclaimed proofs.
      // For now, users need to manually recover via seed restore if this happens.
      const rollingBackOps = await this.sendOperationRepository.getByState('rolling_back');
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

      // 7. Clean up orphaned proof reservations
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
    // Find any proofs that might have been reserved for this operation
    const reservedProofs = await this.proofRepository.getReservedProofs();
    const orphanedForOp = reservedProofs.filter((p) => p.usedByOperationId === op.id);

    if (orphanedForOp.length > 0) {
      await this.proofService.releaseProofs(
        op.mintUrl,
        orphanedForOp.map((p) => p.secret),
      );
    }

    await this.sendOperationRepository.delete(op.id);
    this.logger?.info('Cleaned up failed init operation', { operationId: op.id });
  }

  /**
   * Attempts to recover an init operation, swallowing recovery errors.
   * If recovery fails, logs warning and leaves for startup recovery.
   */
  private async tryRecoverInitOperation(op: InitSendOperation): Promise<void> {
    try {
      await this.recoverInitOperation(op);
      this.logger?.info('Recovered init operation after failure', { operationId: op.id });
    } catch (recoveryError) {
      this.logger?.warn('Failed to recover init operation, will retry on next startup', {
        operationId: op.id,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
    }
  }

  /**
   * Recover an executing operation.
   * Determines if swap happened and recovers accordingly.
   */
  private async recoverExecutingOperation(op: ExecutingSendOperation): Promise<void> {
    // Case: Exact match - no mint interaction, always safe to rollback
    if (!op.needsSwap) {
      await this.proofService.releaseProofs(op.mintUrl, op.inputProofSecrets);
      await this.markAsRolledBack(op, 'Recovered: no swap needed, operation never finalized');
      return;
    }

    // Case: Swap required - need to check with mint
    let inputStates: CashuProofState[];
    try {
      inputStates = await this.checkProofStatesWithMint(op.mintUrl, op.inputProofSecrets);
    } catch (e) {
      this.logger?.warn('Could not reach mint for recovery, will retry later', {
        operationId: op.id,
        mintUrl: op.mintUrl,
      });
      return; // Leave in executing state, retry on next startup
    }

    const allSpent = inputStates.every((s) => s.state === 'SPENT');

    if (!allSpent) {
      // Swap never happened - simple rollback
      await this.proofService.releaseProofs(op.mintUrl, op.inputProofSecrets);
      await this.markAsRolledBack(op, 'Recovered: swap never executed');
    } else {
      // Swap happened - check if proofs already saved, otherwise recover from OutputData
      const existingProofs = await this.proofRepository.getProofsByOperationId(op.mintUrl, op.id);

      // Check if output proofs exist by looking for proofs created by this operation
      const outputSecrets = op.outputData
        ? getSecretsFromSerializedOutputData(op.outputData)
        : { keepSecrets: [], sendSecrets: [] };
      const allOutputSecrets = [...outputSecrets.keepSecrets, ...outputSecrets.sendSecrets];
      const alreadySaved = existingProofs.some((p) => allOutputSecrets.includes(p.secret));

      if (!alreadySaved && op.outputData) {
        // Actually need to recover from mint
        await this.recoverProofsFromSwap(op);
      }

      // Mark input proofs as spent (they were consumed by the swap)
      await this.proofService.setProofState(op.mintUrl, op.inputProofSecrets, 'spent');
      await this.markAsRolledBack(op, 'Recovered: swap succeeded but token never returned');
    }
  }

  /**
   * Attempts to recover an executing operation, swallowing recovery errors.
   * If recovery fails (e.g., mint unreachable), logs warning and leaves
   * for startup recovery.
   */
  private async tryRecoverExecutingOperation(op: ExecutingSendOperation): Promise<void> {
    try {
      await this.recoverExecutingOperation(op);
      this.logger?.info('Recovered executing operation after failure', { operationId: op.id });
    } catch (recoveryError) {
      this.logger?.warn('Failed to recover executing operation, will retry on next startup', {
        operationId: op.id,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
    }
  }

  /**
   * Recover proofs from a completed swap using the mint's restore endpoint.
   */
  private async recoverProofsFromSwap(op: ExecutingSendOperation): Promise<void> {
    if (!op.outputData) {
      throw new Error('Cannot recover proofs without outputData');
    }

    const recoveredProofs = await this.proofService.recoverProofsFromOutputData(
      op.mintUrl,
      op.outputData,
    );

    if (recoveredProofs.length > 0) {
      this.logger?.info('Recovered proofs from swap', {
        operationId: op.id,
        proofCount: recoveredProofs.length,
      });
    }
  }

  /**
   * Check a pending operation to see if it should be finalized.
   */
  async checkPendingOperation(op: PendingSendOperation): Promise<void> {
    const sendSecrets = getSendProofSecrets(op);

    let sendStates: CashuProofState[];
    try {
      sendStates = await this.checkProofStatesWithMint(op.mintUrl, sendSecrets);
    } catch (e) {
      this.logger?.warn('Could not reach mint for recovery, will retry later', {
        operationId: op.id,
        mintUrl: op.mintUrl,
      });
      return; // Leave in pending state, retry on next startup
    }

    const allSpent = sendStates.every((s) => s.state === 'SPENT');

    if (allSpent) {
      // Recipient claimed - finalize
      await this.finalize(op.id);
      this.logger?.info('Send operation finalized during recovery', { operationId: op.id });
    } else {
      // Leave as pending - user can rollback manually if desired
      this.logger?.debug('Pending operation token not yet claimed, leaving as pending', {
        operationId: op.id,
      });
    }
  }

  /**
   * Check proof states with the mint.
   */
  private async checkProofStatesWithMint(
    mintUrl: string,
    secrets: string[],
  ): Promise<CashuProofState[]> {
    const wallet = await this.walletService.getWallet(mintUrl);
    const proofInputs = secrets.map((secret) => ({ secret }));
    return wallet.checkProofsStates(proofInputs as unknown as Proof[]);
  }

  /**
   * Mark an operation as rolled back with an error message.
   */
  private async markAsRolledBack(
    op: PreparedOrLaterOperation,
    error: string,
  ): Promise<RolledBackSendOperation> {
    const rolledBack: RolledBackSendOperation = {
      ...op,
      state: 'rolled_back',
      updatedAt: Date.now(),
      error,
    };
    await this.sendOperationRepository.update(rolledBack);

    await this.eventBus.emit('send:rolled-back', {
      mintUrl: op.mintUrl,
      operationId: op.id,
      operation: rolledBack,
    });

    this.logger?.info('Operation rolled back during recovery', {
      operationId: op.id,
      error,
    });

    return rolledBack;
  }

  /**
   * Clean up orphaned proof reservations.
   * Finds proofs that are reserved but point to non-existent or terminal operations.
   */
  private async cleanupOrphanedReservations(): Promise<number> {
    const reservedProofs = await this.proofRepository.getReservedProofs();
    const orphanedProofs: typeof reservedProofs = [];

    for (const proof of reservedProofs) {
      if (!proof.usedByOperationId) continue;

      const operation = await this.sendOperationRepository.getById(proof.usedByOperationId);

      // Orphaned if operation doesn't exist or is in terminal state
      if (!operation || isTerminalOperation(operation)) {
        orphanedProofs.push(proof);
      }
    }

    // Group by mintUrl and release
    const byMint = new Map<string, string[]>();
    for (const proof of orphanedProofs) {
      const secrets = byMint.get(proof.mintUrl) || [];
      secrets.push(proof.secret);
      byMint.set(proof.mintUrl, secrets);
    }

    for (const [mintUrl, secrets] of byMint) {
      await this.proofService.releaseProofs(mintUrl, secrets);
    }

    if (orphanedProofs.length > 0) {
      this.logger?.info('Released orphaned proof reservations', { count: orphanedProofs.length });
    }

    return orphanedProofs.length;
  }

  /**
   * Get an operation by ID.
   */
  async getOperation(operationId: string): Promise<SendOperation | null> {
    return this.sendOperationRepository.getById(operationId);
  }

  /**
   * Get all pending operations.
   */
  async getPendingOperations(): Promise<SendOperation[]> {
    return this.sendOperationRepository.getPending();
  }
}
