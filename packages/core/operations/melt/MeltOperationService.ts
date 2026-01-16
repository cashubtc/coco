import type { MeltOperationRepository, ProofRepository } from '../../repositories';
import type {
  MeltOperation,
  InitMeltOperation,
  PreparedMeltOperation,
  ExecutingMeltOperation,
  PendingMeltOperation,
  FinalizedMeltOperation,
  RollingBackMeltOperation,
  RolledBackMeltOperation,
  PreparedOrLaterOperation,
} from './MeltOperation';
import { createMeltOperation, hasPreparedData } from './MeltOperation';
import type { MeltMethod, MeltMethodData, PendingCheckResult } from './MeltMethodHandler';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import { generateSubId } from '../../utils';
import {
  UnknownMintError,
  ProofValidationError,
  OperationInProgressError,
} from '../../models/Error';
import type { MintAdapter } from '@core/infra';
import type { MeltHandlerProvider } from '../../infra/handlers';

/**
 * MeltOperationService orchestrates melt sagas while delegating
 * method-specific behavior to MeltMethodHandlers.
 */
export class MeltOperationService {
  private readonly handlerProvider: MeltHandlerProvider;
  private readonly meltOperationRepository: MeltOperationRepository;
  private readonly proofRepository: ProofRepository;
  private readonly proofService: ProofService;
  private readonly mintService: MintService;
  private readonly walletService: WalletService;
  private readonly mintAdapter: MintAdapter;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  private readonly operationLocks: Map<string, Promise<void>> = new Map();
  private recoveryLock: Promise<void> | null = null;

  constructor(
    handlerProvider: MeltHandlerProvider,
    meltOperationRepository: MeltOperationRepository,
    proofRepository: ProofRepository,
    proofService: ProofService,
    mintService: MintService,
    walletService: WalletService,
    mintAdapter: MintAdapter,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.handlerProvider = handlerProvider;
    this.meltOperationRepository = meltOperationRepository;
    this.proofRepository = proofRepository;
    this.proofService = proofService;
    this.mintService = mintService;
    this.walletService = walletService;
    this.mintAdapter = mintAdapter;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  private buildDeps() {
    return {
      proofRepository: this.proofRepository,
      proofService: this.proofService,
      walletService: this.walletService,
      mintService: this.mintService,
      mintAdapter: this.mintAdapter,
      eventBus: this.eventBus,
      logger: this.logger,
    };
  }

  private async acquireOperationLock(operationId: string): Promise<() => void> {
    const existingLock = this.operationLocks.get(operationId);
    if (existingLock) {
      throw new OperationInProgressError(operationId);
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

  isOperationLocked(operationId: string): boolean {
    return this.operationLocks.has(operationId);
  }

  isRecoveryInProgress(): boolean {
    return this.recoveryLock !== null;
  }

  async init(
    mintUrl: string,
    method: MeltMethod,
    methodData: MeltMethodData,
  ): Promise<InitMeltOperation> {
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    if (
      methodData.amountSats &&
      (!Number.isFinite(methodData.amountSats) || methodData.amountSats <= 0)
    ) {
      throw new ProofValidationError('Amount must be a positive number');
    }

    const id = generateSubId();
    const operation = createMeltOperation(id, mintUrl, {
      method,
      methodData,
    });

    await this.meltOperationRepository.create(operation);
    this.logger?.debug('Melt operation created', { operationId: id, mintUrl, method });

    return operation;
  }

  /**
   * Prepare the operation by reserving proofs and creating outputs.
   * After this step, the operation can be executed or rolled back.
   *
   * If preparation fails, automatically attempts to recover the init operation.
   * Throws if the operation is already in progress.
   */
  async prepare(operationId: string): Promise<PreparedMeltOperation> {
    const releaseLock = await this.acquireOperationLock(operationId);
    try {
      const operation = await this.meltOperationRepository.getById(operationId);
      if (!operation || operation.state !== 'init') {
        throw new Error(
          `Cannot prepare operation ${operationId}: expected state 'init' but found '${
            operation?.state ?? 'not found'
          }'`,
        );
      }

      const initOp = operation as InitMeltOperation;

      try {
        const handler = this.handlerProvider.get(initOp.method);
        const { wallet } = await this.walletService.getWalletWithActiveKeysetId(initOp.mintUrl);
        const prepared = await handler.prepare({
          ...this.buildDeps(),
          operation: initOp,
          wallet,
        });

        const preparedOp: PreparedMeltOperation = {
          ...prepared,
          state: 'prepared',
          updatedAt: Date.now(),
        };

        await this.meltOperationRepository.update(preparedOp);
        await this.eventBus.emit('melt-op:prepared', {
          mintUrl: preparedOp.mintUrl,
          operationId: preparedOp.id,
          operation: preparedOp,
        });

        this.logger?.info('Melt operation prepared', {
          operationId: preparedOp.id,
          method: preparedOp.method,
        });

        return preparedOp;
      } catch (e) {
        // Attempt to clean up the init operation before re-throwing
        await this.tryRecoverInitOperation(initOp);
        throw e;
      }
    } finally {
      releaseLock();
    }
  }

  /**
   * Execute the prepared operation.
   * Performs the melt (swap if needed) and processes the result.
   *
   * If execution fails after transitioning to 'executing' state,
   * automatically attempts to recover the operation.
   * Throws if the operation is already in progress.
   */
  async execute(operationId: string): Promise<PendingMeltOperation | FinalizedMeltOperation> {
    const releaseLock = await this.acquireOperationLock(operationId);
    try {
      const operation = await this.meltOperationRepository.getById(operationId);
      if (!operation || operation.state !== 'prepared') {
        throw new Error(
          `Cannot execute operation ${operationId}: expected state 'prepared' but found '${
            operation?.state ?? 'not found'
          }'`,
        );
      }

      const preparedOp = operation as PreparedMeltOperation;

      // Mark as executing FIRST - this must happen before any mint interaction
      const executing: ExecutingMeltOperation = {
        ...preparedOp,
        state: 'executing',
        updatedAt: Date.now(),
      };
      await this.meltOperationRepository.update(executing);

      try {
        const handler = this.handlerProvider.get(executing.method);
        const { wallet } = await this.walletService.getWalletWithActiveKeysetId(executing.mintUrl);
        const operationProofs = await this.proofRepository.getProofsByOperationId(
          executing.mintUrl,
          executing.id,
        );
        const reservedProofs = operationProofs.filter((p) => p.usedByOperationId === operationId);

        const result = await handler.execute({
          ...this.buildDeps(),
          operation: executing,
          wallet,
          reservedProofs,
        });

        switch (result.status) {
          case 'PAID': {
            // Melt was immediately paid, finalize right away
            const finalizedOp: FinalizedMeltOperation = {
              ...result.finalized,
              state: 'finalized',
              updatedAt: Date.now(),
            };

            await this.meltOperationRepository.update(finalizedOp);
            await this.eventBus.emit('melt-op:finalized', {
              mintUrl: finalizedOp.mintUrl,
              operationId: finalizedOp.id,
              operation: finalizedOp,
            });

            this.logger?.info('Melt operation executing -> finalized (immediate)', {
              operationId: finalizedOp.id,
              method: finalizedOp.method,
            });

            return finalizedOp;
          }
          case 'PENDING': {
            // Melt is pending, move to pending state
            const pendingOp: PendingMeltOperation = {
              ...result.pending,
              state: 'pending',
              updatedAt: Date.now(),
            };

            await this.meltOperationRepository.update(pendingOp);
            await this.eventBus.emit('melt-op:pending', {
              mintUrl: pendingOp.mintUrl,
              operationId: pendingOp.id,
              operation: pendingOp,
            });

            this.logger?.info('Melt operation executing -> pending', {
              operationId: pendingOp.id,
              method: pendingOp.method,
            });

            return pendingOp;
          }
          case 'FAILED': {
            // Execution reported failure, trigger recovery
            throw new Error(result.failed.error ?? 'Melt execution failed');
          }
        }
      } catch (e) {
        // Attempt to recover the executing operation before re-throwing
        await this.tryRecoverExecutingOperation(executing);
        throw e;
      }
    } finally {
      releaseLock();
    }
  }

  async finalize(operationId: string): Promise<void> {
    const releaseLock = await this.acquireOperationLock(operationId);
    try {
      const operation = await this.meltOperationRepository.getById(operationId);
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

      const pendingOp = operation as PendingMeltOperation;
      const handler = this.handlerProvider.get(pendingOp.method);
      await handler.finalize?.({
        ...this.buildDeps(),
        operation: pendingOp,
      });

      const finalized: FinalizedMeltOperation = {
        ...pendingOp,
        state: 'finalized',
        updatedAt: Date.now(),
      };

      await this.meltOperationRepository.update(finalized);
      await this.eventBus.emit('melt-op:finalized', {
        mintUrl: pendingOp.mintUrl,
        operationId,
        operation: finalized,
      });

      this.logger?.info('Melt operation finalized', { operationId });
    } finally {
      releaseLock();
    }
  }

  async rollback(operationId: string, reason = 'Rolled back'): Promise<void> {
    const releaseLock = await this.acquireOperationLock(operationId);
    try {
      const operation = await this.meltOperationRepository.getById(operationId);
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

      if (!hasPreparedData(operation)) {
        throw new Error(`Operation ${operationId} is not in a rollbackable state`);
      }

      const handler = this.handlerProvider.get(operation.method);
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(operation.mintUrl);

      // For pending operations, verify the quote is actually UNPAID before rolling back.
      // This prevents releasing proofs that are still inflight with the Lightning network.
      if (operation.state === 'pending') {
        const pendingOp = operation as PendingMeltOperation;
        const decision = await handler.checkPending?.({
          ...this.buildDeps(),
          operation: pendingOp,
          wallet,
        });
        if (decision !== 'rollback') {
          throw new Error(
            `Cannot rollback pending operation: quote state is not UNPAID (decision: ${decision})`,
          );
        }
      }

      let opForRollback: PreparedOrLaterOperation = operation;
      const rolling: RollingBackMeltOperation = {
        ...operation,
        state: 'rolling_back',
        updatedAt: Date.now(),
      };
      await this.meltOperationRepository.update(rolling);
      opForRollback = rolling;

      await handler.rollback?.({
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
      const initOps = await this.meltOperationRepository.getByState('init');
      for (const op of initOps) {
        await this.recoverInitOperation(op as InitMeltOperation);
        initCount++;
      }

      // 2. Log warnings for prepared operations (leave for user to decide)
      const preparedOps = await this.meltOperationRepository.getByState('prepared');
      for (const op of preparedOps) {
        this.logger?.warn('Found stale prepared operation, user can rollback manually', {
          operationId: op.id,
        });
      }

      // 3. Recover executing operations
      const executingOps = await this.meltOperationRepository.getByState('executing');
      for (const op of executingOps) {
        try {
          await this.recoverExecutingOperation(op as ExecutingMeltOperation);
          executingCount++;
        } catch (e) {
          this.logger?.error('Error recovering executing operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // 4. Check pending operations
      const pendingOps = await this.meltOperationRepository.getByState('pending');
      for (const op of pendingOps) {
        try {
          await this.checkPendingOperation(op.id);
          pendingCount++;
        } catch (e) {
          this.logger?.error('Error checking pending melt operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // 5. Warn about rolling_back operations (need manual intervention)
      const rollingBackOps = await this.meltOperationRepository.getByState('rolling_back');
      for (const op of rollingBackOps) {
        this.logger?.warn(
          'Found operation stuck in rolling_back state. ' +
            'This indicates a crash during rollback. Manual recovery may be needed.',
          {
            operationId: op.id,
            mintUrl: op.mintUrl,
            method: op.method,
          },
        );
        rollingBackCount++;
      }

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

  async checkPendingOperation(operationId: string): Promise<PendingCheckResult> {
    const op = await this.getOperation(operationId);
    if (!op || op.state !== 'pending') {
      throw new Error(
        `Cannot check operation ${operationId}: expected state 'pending' but found '${
          op?.state ?? 'not found'
        }'`,
      );
    }
    const handler = this.handlerProvider.get(op.method);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(op.mintUrl);
    const decision: PendingCheckResult =
      (await handler.checkPending?.({
        ...this.buildDeps(),
        operation: op,
        wallet,
      })) ?? 'stay_pending';

    if (decision === 'finalize') {
      await this.finalize(op.id);
      return 'finalize';
    } else if (decision === 'rollback') {
      await this.rollback(op.id, 'Rollback requested by handler');
      return 'rollback';
    } else {
      this.logger?.debug('Pending melt remains pending', { operationId: op.id });
      return 'stay_pending';
    }
  }

  private async markAsRolledBack(
    op: PreparedOrLaterOperation,
    error: string,
  ): Promise<RolledBackMeltOperation> {
    const rolledBack: RolledBackMeltOperation = {
      ...op,
      state: 'rolled_back',
      updatedAt: Date.now(),
      error,
    };
    await this.meltOperationRepository.update(rolledBack);

    await this.eventBus.emit('melt-op:rolled-back', {
      mintUrl: op.mintUrl,
      operationId: op.id,
      operation: rolledBack,
    });

    this.logger?.info('Melt operation rolled back', {
      operationId: op.id,
      error,
    });

    return rolledBack;
  }

  /**
   * Clean up a failed init operation.
   * Releases any orphaned proof reservations and deletes the operation.
   */
  private async recoverInitOperation(op: InitMeltOperation): Promise<void> {
    // Find any proofs that might have been reserved for this operation
    const reservedProofs = await this.proofRepository.getReservedProofs();
    const orphanedForOp = reservedProofs.filter((p) => p.usedByOperationId === op.id);

    if (orphanedForOp.length > 0) {
      await this.proofService.releaseProofs(
        op.mintUrl,
        orphanedForOp.map((p) => p.secret),
      );
    }

    await this.meltOperationRepository.delete(op.id);
    this.logger?.info('Cleaned up failed init operation', { operationId: op.id });
  }

  /**
   * Attempts to recover an init operation, swallowing recovery errors.
   * If recovery fails, logs warning and leaves for startup recovery.
   */
  private async tryRecoverInitOperation(op: InitMeltOperation): Promise<void> {
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
   * Delegates to handler for proof cleanup and state determination.
   * Updates operation state based on handler result (finalized, pending, or failed).
   */
  private async recoverExecutingOperation(op: ExecutingMeltOperation): Promise<void> {
    const handler = this.handlerProvider.get(op.method);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(op.mintUrl);

    const result = await handler.recoverExecuting({
      ...this.buildDeps(),
      operation: op,
      wallet,
    });

    switch (result.status) {
      case 'PAID': {
        const finalizedOp: FinalizedMeltOperation = {
          ...result.finalized,
          state: 'finalized',
          updatedAt: Date.now(),
        };
        await this.meltOperationRepository.update(finalizedOp);
        await this.eventBus.emit('melt-op:finalized', {
          mintUrl: finalizedOp.mintUrl,
          operationId: finalizedOp.id,
          operation: finalizedOp,
        });
        this.logger?.info('Recovered executing operation as finalized', {
          operationId: op.id,
        });
        break;
      }
      case 'PENDING': {
        const pendingOp: PendingMeltOperation = {
          ...result.pending,
          state: 'pending',
          updatedAt: Date.now(),
        };
        await this.meltOperationRepository.update(pendingOp);
        await this.eventBus.emit('melt-op:pending', {
          mintUrl: pendingOp.mintUrl,
          operationId: pendingOp.id,
          operation: pendingOp,
        });
        this.logger?.info('Recovered executing operation as pending', {
          operationId: op.id,
        });
        break;
      }
      case 'FAILED': {
        await this.markAsRolledBack(op, result.failed.error ?? 'Recovered: operation failed');
        break;
      }
    }
  }

  /**
   * Attempts to recover an executing operation, swallowing recovery errors.
   * If recovery fails (e.g., mint unreachable), logs warning and leaves
   * for startup recovery.
   */
  private async tryRecoverExecutingOperation(op: ExecutingMeltOperation): Promise<void> {
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

  async getOperation(operationId: string): Promise<MeltOperation | null> {
    return this.meltOperationRepository.getById(operationId);
  }

  async getOperationByQuote(mintUrl: string, quoteId: string): Promise<MeltOperation | null> {
    const operations = await this.meltOperationRepository.getByQuoteId(mintUrl, quoteId);
    const matching = operations.filter((operation) => hasPreparedData(operation));

    if (matching.length === 0) {
      return null;
    }

    if (matching.length > 1) {
      throw new Error(
        `Found ${matching.length} melt operations for mint ${mintUrl} and quote ${quoteId}`,
      );
    }

    return matching[0]!;
  }

  async getPendingOperations(): Promise<MeltOperation[]> {
    return this.meltOperationRepository.getPending();
  }
}
