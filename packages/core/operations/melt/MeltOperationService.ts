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
import { createMeltOperation, hasPreparedData, isTerminalOperation } from './MeltOperation';
import type {
  MeltMethod,
  MeltMethodData,
  MeltMethodHandler,
  PendingCheckResult,
} from './MeltMethodHandler';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import { generateSubId } from '../../utils';
import { UnknownMintError, ProofValidationError } from '../../models/Error';
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

  async prepare(operation: InitMeltOperation): Promise<PreparedMeltOperation> {
    const releaseLock = await this.acquireOperationLock(operation.id);
    try {
      const handler = this.handlerProvider.get(operation.method);
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(operation.mintUrl);
      const prepared = await handler.prepare({
        ...this.buildDeps(),
        operation,
        wallet,
      });

      const preparedOp: PreparedMeltOperation = {
        ...prepared,
        state: 'prepared',
        updatedAt: Date.now(),
      };

      await this.meltOperationRepository.update(preparedOp);
      await this.eventBus.emit(
        'melt:prepared' as any,
        {
          mintUrl: preparedOp.mintUrl,
          operationId: preparedOp.id,
          operation: preparedOp,
        } as any,
      );

      this.logger?.info('Melt operation prepared', {
        operationId: preparedOp.id,
        method: preparedOp.method,
      });

      return preparedOp;
    } finally {
      releaseLock();
    }
  }

  async execute(
    operation: PreparedMeltOperation,
  ): Promise<PendingMeltOperation | FinalizedMeltOperation> {
    const releaseLock = await this.acquireOperationLock(operation.id);
    try {
      const handler = this.handlerProvider.get(operation.method);
      const executing: ExecutingMeltOperation = {
        ...operation,
        state: 'executing',
        updatedAt: Date.now(),
      };
      await this.meltOperationRepository.update(executing);

      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(executing.mintUrl);
      const reservedProofs = await this.proofRepository.getProofsByOperationId(
        executing.mintUrl,
        executing.id,
      );

      const result = await handler.execute({
        ...this.buildDeps(),
        operation: executing,
        wallet,
        reservedProofs,
      });

      if (result.status === 'PAID') {
        // Melt was immediately paid, finalize right away
        const finalizedOp: FinalizedMeltOperation = {
          ...result.finalized,
          state: 'finalized',
          updatedAt: Date.now(),
        };

        await this.meltOperationRepository.update(finalizedOp);
        await this.eventBus.emit(
          'melt:finalized' as any,
          {
            mintUrl: finalizedOp.mintUrl,
            operationId: finalizedOp.id,
            operation: finalizedOp,
          } as any,
        );

        this.logger?.info('Melt operation executing -> finalized (immediate)', {
          operationId: finalizedOp.id,
          method: finalizedOp.method,
        });

        return finalizedOp;
      } else {
        // Melt is pending, move to pending state
        const pendingOp: PendingMeltOperation = {
          ...result.pending,
          state: 'pending',
          updatedAt: Date.now(),
        };

        await this.meltOperationRepository.update(pendingOp);
        await this.eventBus.emit(
          'melt:pending' as any,
          {
            mintUrl: pendingOp.mintUrl,
            operationId: pendingOp.id,
            operation: pendingOp,
          } as any,
        );

        this.logger?.info('Melt operation executing -> pending', {
          operationId: pendingOp.id,
          method: pendingOp.method,
        });

        return pendingOp;
      }
    } finally {
      releaseLock();
    }
  }

  async finalize(operationId: string): Promise<void> {
    const preCheck = await this.meltOperationRepository.getById(operationId);
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
      const operation = await this.meltOperationRepository.getById(operationId);
      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
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
      await this.eventBus.emit(
        'melt:finalized' as any,
        {
          mintUrl: pendingOp.mintUrl,
          operationId,
          operation: finalized,
        } as any,
      );

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
        operation.state === 'init'
      ) {
        throw new Error(`Cannot rollback operation in state ${operation.state}`);
      }

      if (!hasPreparedData(operation)) {
        throw new Error(`Operation ${operationId} is not in a rollbackable state`);
      }

      const handler = this.handlerProvider.get(operation.method);
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(operation.mintUrl);

      let opForRollback: PreparedOrLaterOperation = operation;
      if (operation.state === 'pending') {
        const rolling: RollingBackMeltOperation = {
          ...operation,
          state: 'rolling_back',
          updatedAt: Date.now(),
        };
        await this.meltOperationRepository.update(rolling);
        opForRollback = rolling;
      }

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

  async recoverPendingOperations(): Promise<void> {
    if (this.recoveryLock) {
      throw new Error('Recovery is already in progress');
    }

    let releaseRecoveryLock: () => void;
    this.recoveryLock = new Promise<void>((resolve) => {
      releaseRecoveryLock = resolve;
    });

    try {
      const pendingOps = await this.meltOperationRepository.getByState('pending');
      for (const op of pendingOps) {
        try {
          await this.checkPendingOperation(op as PendingMeltOperation);
        } catch (e) {
          this.logger?.error('Error checking pending melt operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const orphaned = await this.cleanupOrphanedReservations();
      if (orphaned > 0) {
        this.logger?.info('Recovery released orphaned reservations', { count: orphaned });
      }
    } finally {
      this.recoveryLock = null;
      releaseRecoveryLock!();
    }
  }

  private async checkPendingOperation(op: PendingMeltOperation): Promise<void> {
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
    } else if (decision === 'rollback') {
      await this.rollback(op.id, 'Rollback requested by handler');
    } else {
      this.logger?.debug('Pending melt remains pending', { operationId: op.id });
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

    await this.eventBus.emit(
      'melt:rolled-back' as any,
      {
        mintUrl: op.mintUrl,
        operationId: op.id,
        operation: rolledBack,
      } as any,
    );

    this.logger?.info('Melt operation rolled back', {
      operationId: op.id,
      error,
    });

    return rolledBack;
  }

  private async cleanupOrphanedReservations(): Promise<number> {
    const reservedProofs = await this.proofRepository.getReservedProofs();
    const orphanedProofs: typeof reservedProofs = [];

    for (const proof of reservedProofs) {
      if (!proof.usedByOperationId) continue;

      const operation = await this.meltOperationRepository.getById(proof.usedByOperationId);

      if (!operation || isTerminalOperation(operation)) {
        orphanedProofs.push(proof);
      }
    }

    const byMint = new Map<string, string[]>();
    for (const proof of orphanedProofs) {
      const secrets = byMint.get(proof.mintUrl) || [];
      secrets.push(proof.secret);
      byMint.set(proof.mintUrl, secrets);
    }

    for (const [mintUrl, secrets] of byMint) {
      await this.proofRepository.releaseProofs(mintUrl, secrets);
    }

    return orphanedProofs.length;
  }

  async getOperation(operationId: string): Promise<MeltOperation | null> {
    return this.meltOperationRepository.getById(operationId);
  }

  async getPendingOperations(): Promise<MeltOperation[]> {
    return this.meltOperationRepository.getPending();
  }
}
