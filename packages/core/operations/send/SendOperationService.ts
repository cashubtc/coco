import type { Token, Proof, ProofState as CashuProofState } from '@cashu/cashu-ts';
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
  isTerminalOperation,
  type CreateSendOperationOptions,
} from './SendOperation';
import type { SendMethod, SendMethodData } from './SendMethodHandler';
import { SendHandlerProvider } from '../../infra/handlers/send/SendHandlerProvider';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import {
  generateSubId,
} from '../../utils';
import { UnknownMintError, ProofValidationError, OperationInProgressError } from '../../models/Error';
import { MintScopedLock } from '../MintScopedLock';
import { OperationIdLock } from '../OperationIdLock';

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
  private readonly handlerProvider: SendHandlerProvider;
  private readonly logger?: Logger;

  /** In-memory lock to prevent concurrent operations on the same operation ID */
  private readonly operationIdLock = new OperationIdLock();
  /** Lock for the global recovery process */
  private recoveryLock: Promise<void> | null = null;
  /** In-memory lock to serialize proof selection/reservation per mint */
  private readonly mintScopedLock: MintScopedLock;

  constructor(
    sendOperationRepository: SendOperationRepository,
    proofRepository: ProofRepository,
    proofService: ProofService,
    mintService: MintService,
    walletService: WalletService,
    eventBus: EventBus<CoreEvents>,
    handlerProvider: SendHandlerProvider,
    logger?: Logger,
    mintScopedLock?: MintScopedLock,
  ) {
    this.sendOperationRepository = sendOperationRepository;
    this.proofRepository = proofRepository;
    this.proofService = proofService;
    this.mintService = mintService;
    this.walletService = walletService;
    this.eventBus = eventBus;
    this.handlerProvider = handlerProvider;
    this.logger = logger;
    this.mintScopedLock = mintScopedLock ?? new MintScopedLock();
  }

  private buildDeps() {
    return {
      proofRepository: this.proofRepository,
      proofService: this.proofService,
      walletService: this.walletService,
      mintService: this.mintService,
      eventBus: this.eventBus,
      logger: this.logger,
    };
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
    amount: number,
    options: CreateSendOperationOptions<M> = {
      method: 'default' as M,
      methodData: {} as SendMethodData<M>,
    },
  ): Promise<InitSendOperation> {
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ProofValidationError('Amount must be a positive number');
    }

    const id = generateSubId();
    const operation = createSendOperation(id, mintUrl, amount, options);

    await this.sendOperationRepository.create(operation);
    this.logger?.debug('Send operation created', {
      operationId: id,
      mintUrl,
      amount,
      method: options.method,
    });

    return operation;
  }

  /**
   * Prepare the operation by reserving proofs and creating outputs.
   * After this step, the operation can be executed or rolled back.
   *
   * If preparation fails, automatically attempts to recover the init operation.
   * Throws if the operation is already in progress.
   *
   * Delegates to the appropriate handler based on the operation method.
   */
  async prepare(operation: InitSendOperation): Promise<PreparedSendOperation> {
    if (!this.handlerProvider) {
      throw new Error('SendHandlerProvider is required');
    }

    const releaseLock = await this.acquireOperationLock(operation.id);
    try {
      const releaseMintLock = await this.mintScopedLock.acquire(operation.mintUrl);
      let prepared: PreparedSendOperation;
      try {
        const handler = this.handlerProvider.get(operation.method);
        if (!handler) {
          throw new Error(`No handler registered for method: ${operation.method}`);
        }

        const { wallet } = await this.walletService.getWalletWithActiveKeysetId(operation.mintUrl);
        const ctx = {
          operation,
          wallet,
          proofRepository: this.proofRepository,
          proofService: this.proofService,
          walletService: this.walletService,
          mintService: this.mintService,
          eventBus: this.eventBus,
          logger: this.logger,
        };

        prepared = await handler.prepare(ctx);
        // Save the prepared operation to the repository
        await this.sendOperationRepository.update(prepared);
      } catch (e) {
        // Attempt to clean up the init operation before re-throwing
        await this.tryRecoverInitOperation(operation);
        throw e;
      } finally {
        releaseMintLock();
      }

      await this.eventBus.emit('send:prepared', {
        mintUrl: prepared.mintUrl,
        operationId: prepared.id,
        operation: prepared,
      });

      return prepared;
    } finally {
      releaseLock();
    }
  }

  /**
   * Execute the prepared operation.
   * Performs the swap (if needed) and creates the token.
   *
   * If execution fails after transitioning to 'executing' state,
   * automatically attempts to recover the operation.
   * Throws if the operation is already in progress.
   *
   * Delegates to the appropriate handler based on the operation method.
   */
  async execute(
    operation: PreparedSendOperation,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    if (!this.handlerProvider) {
      throw new Error('SendHandlerProvider is required');
    }

    const releaseLock = await this.acquireOperationLock(operation.id);
    try {
      // Mark as executing FIRST - this must happen before any mint interaction
      const executing: ExecutingSendOperation = {
        ...operation,
        state: 'executing',
        updatedAt: Date.now(),
      };
      await this.sendOperationRepository.update(executing);

      let pending: PendingSendOperation | null = null;
      let token: Token | null = null;
      let failed: RolledBackSendOperation | null = null;
      try {
        const handler = this.handlerProvider.get(operation.method);
        if (!handler) {
          throw new Error(`No handler registered for method: ${operation.method}`);
        }

        const { wallet } = await this.walletService.getWalletWithActiveKeysetId(operation.mintUrl);
        const reservedProofs = await this.proofRepository.getProofsByOperationId(
          operation.mintUrl,
          operation.id,
        );

        const ctx = {
          operation: executing,
          wallet,
          reservedProofs,
          proofRepository: this.proofRepository,
          proofService: this.proofService,
          walletService: this.walletService,
          mintService: this.mintService,
          eventBus: this.eventBus,
          logger: this.logger,
        };

        const result = await handler.execute(ctx);

        if (result.status === 'PENDING') {
          // Save the pending operation to the repository
          await this.sendOperationRepository.update(result.pending);
          pending = result.pending;
          token = result.token ?? null;
        } else {
          // Handler returned FAILED - persist the terminal result without re-running recovery
          await this.sendOperationRepository.update(result.failed);
          await this.eventBus.emit('send:rolled-back', {
            mintUrl: result.failed.mintUrl,
            operationId: result.failed.id,
            operation: result.failed,
          });
          failed = result.failed;
        }
      } catch (e) {
        // Attempt to recover the executing operation before re-throwing
        await this.tryRecoverExecutingOperation(executing);
        throw e;
      }

      if (failed) {
        this.logger?.info('Send operation execution failed', {
          operationId: failed.id,
          error: failed.error,
        });
        throw new Error(failed.error || 'Handler execution failed');
      }

      if (!pending || !token) {
        throw new Error(`Send operation ${operation.id} did not produce a pending result`);
      }

      await this.eventBus.emit('send:pending', {
        mintUrl: pending.mintUrl,
        operationId: pending.id,
        operation: pending,
        token,
      });

      return { operation: pending, token };
    } finally {
      releaseLock();
    }
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

    let releaseLock: (() => void) | undefined;
    try {
      try {
        releaseLock = await this.acquireOperationLock(operationId);
      } catch (error) {
        if (!(error instanceof OperationInProgressError)) {
          throw error;
        }

        await this.operationIdLock.waitForUnlock(operationId);

        const latest = await this.sendOperationRepository.getById(operationId);
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

      const handler = this.handlerProvider.get(pendingOp.method);
      await handler.finalize?.({
        ...this.buildDeps(),
        operation: pendingOp,
      });

      const finalized: FinalizedSendOperation = {
        ...pendingOp,
        state: 'finalized',
        updatedAt: Date.now(),
      };
      await this.sendOperationRepository.update(finalized);

      await this.eventBus.emit('send:finalized', {
        mintUrl: pendingOp.mintUrl,
        operationId,
        operation: finalized,
      });

      this.logger?.info('Send operation finalized', { operationId });
    } finally {
      releaseLock?.();
    }
  }

  /**
   * Rollback an operation by reclaiming the proofs.
   * Only works for operations in 'prepared' or 'pending' state.
   * Throws if the operation is already in progress.
   */
  async rollback(operationId: string, reason = 'Rolled back by user action'): Promise<void> {
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
        operation.state === 'init' ||
        operation.state === 'executing'
      ) {
        throw new Error(`Cannot rollback operation in state ${operation.state}`);
      }

      // At this point, operation has PreparedData
      if (!hasPreparedData(operation)) {
        throw new Error(`Operation ${operationId} is not in a rollbackable state`);
      }

      const handler = this.handlerProvider.get(operation.method);
      if (!handler.rollback) {
        throw new Error(`Send operations of method ${operation.method} can not be rolled back`);
      }

      if (operation.state === 'pending' && operation.method === 'p2pk') {
        throw new Error('Cannot rollback pending P2PK send operation');
      }

      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(operation.mintUrl);

      let opForRollback: PreparedOrLaterOperation = operation;
      if (operation.state === 'pending') {
        const rollingBack: RollingBackSendOperation = {
          ...operation,
          state: 'rolling_back',
          updatedAt: Date.now(),
        };
        await this.sendOperationRepository.update(rollingBack);
        opForRollback = rollingBack;
      }

      await handler.rollback({
        ...this.buildDeps(),
        operation: opForRollback,
        wallet,
      });

      await this.markAsRolledBack(opForRollback, reason);
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
   * Delegates to the handler for recovery logic.
   */
  private async recoverExecutingOperation(op: ExecutingSendOperation): Promise<void> {
    const handler = this.handlerProvider.get(op.method);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(op.mintUrl);

    const result = await handler.recoverExecuting({
      ...this.buildDeps(),
      operation: op,
      wallet,
    });

    if (result.status === 'PENDING') {
      await this.sendOperationRepository.update(result.pending);
      if (result.token) {
        await this.eventBus.emit('send:pending', {
          mintUrl: result.pending.mintUrl,
          operationId: result.pending.id,
          operation: result.pending,
          token: result.token,
        });
      }
      this.logger?.info('Recovered executing operation as pending', { operationId: op.id });
      return;
    }

    await this.markAsRolledBack(op, result.failed.error ?? 'Recovered: operation failed');
  }

  /**
   * Attempts to recover an executing operation, swallowing recovery errors.
   * If recovery fails (e.g., mint unreachable), logs warning and leaves
   * for startup recovery.
   */
  private async tryRecoverExecutingOperation(op: ExecutingSendOperation): Promise<void> {
    try {
      const latest = await this.sendOperationRepository.getById(op.id);
      if (!latest || latest.state !== 'executing') {
        this.logger?.debug('Skipping executing operation recovery because state changed', {
          operationId: op.id,
          state: latest?.state,
        });
        return;
      }

      await this.recoverExecutingOperation(latest);
      this.logger?.info('Recovered executing operation after failure', { operationId: op.id });
    } catch (recoveryError) {
      this.logger?.warn('Failed to recover executing operation, will retry on next startup', {
        operationId: op.id,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
    }
  }

  /**
   * Check a pending operation to see if it should be finalized.
   */
  async checkPendingOperation(op: PendingSendOperation): Promise<void> {
    const handler = this.handlerProvider.get(op.method);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(op.mintUrl);

    const decision =
      (await handler.checkPending?.({
        ...this.buildDeps(),
        operation: op,
        wallet,
      })) ?? (await this.defaultCheckPendingDecision(op));

    if (decision === 'finalize') {
      await this.finalize(op.id);
      this.logger?.info('Send operation finalized during recovery', { operationId: op.id });
    } else if (decision === 'rollback') {
      await this.rollback(op.id, 'Rollback requested by handler');
    } else {
      this.logger?.debug('Pending operation token not yet claimed, leaving as pending', {
        operationId: op.id,
      });
    }
  }

  private async defaultCheckPendingDecision(
    op: PendingSendOperation,
  ): Promise<'finalize' | 'stay_pending'> {
    const sendSecrets = getSendProofSecrets(op);

    let sendStates: CashuProofState[];
    try {
      sendStates = await this.checkProofStatesWithMint(op.mintUrl, sendSecrets);
    } catch (_e) {
      this.logger?.warn('Could not reach mint for recovery, will retry later', {
        operationId: op.id,
        mintUrl: op.mintUrl,
      });
      return 'stay_pending';
    }

    return sendStates.every((s) => s.state === 'SPENT') ? 'finalize' : 'stay_pending';
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

  /**
   * Get all prepared operations.
   */
  async getPreparedOperations(): Promise<PreparedSendOperation[]> {
    const ops = await this.sendOperationRepository.getByState('prepared');
    return ops.filter((op): op is PreparedSendOperation => op.state === 'prepared');
  }
}
