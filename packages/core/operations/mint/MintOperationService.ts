import type { Proof } from '@cashu/cashu-ts';
import type {
  MintOperationRepository,
  MintQuoteRepository,
  ProofRepository,
} from '../../repositories';
import type {
  ExecutingMintOperation,
  FinalizedMintOperation,
  InitMintOperation,
  MintOperation,
  PreparedMintOperation,
  PreparedOrLaterOperation,
} from './MintOperation';
import { createMintOperation, getOutputProofSecrets, hasPreparedData } from './MintOperation';
import type { MintMethod, MintMethodData, MintMethodMeta } from './MintMethodHandler';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import { generateSubId, mapProofToCoreProof } from '../../utils';
import {
  OperationInProgressError,
  NetworkError,
  ProofValidationError,
  UnknownMintError,
} from '../../models/Error';
import type { MintAdapter } from '../../infra';
import type { MintHandlerProvider } from '../../infra/handlers';
import { MintScopedLock } from '../MintScopedLock';
import { OperationIdLock } from '../OperationIdLock';

/**
 * MintOperationService orchestrates mint quote redemption as a crash-safe saga.
 */
export class MintOperationService {
  private readonly handlerProvider: MintHandlerProvider;
  private readonly mintOperationRepository: MintOperationRepository;
  private readonly mintQuoteRepository: MintQuoteRepository;
  private readonly proofRepository: ProofRepository;
  private readonly proofService: ProofService;
  private readonly mintService: MintService;
  private readonly walletService: WalletService;
  private readonly mintAdapter: MintAdapter;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  private readonly operationIdLock = new OperationIdLock();
  private recoveryLock: Promise<void> | null = null;
  private readonly mintScopedLock: MintScopedLock;

  constructor(
    handlerProvider: MintHandlerProvider,
    mintOperationRepository: MintOperationRepository,
    mintQuoteRepository: MintQuoteRepository,
    proofRepository: ProofRepository,
    proofService: ProofService,
    mintService: MintService,
    walletService: WalletService,
    mintAdapter: MintAdapter,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
    mintScopedLock?: MintScopedLock,
  ) {
    this.handlerProvider = handlerProvider;
    this.mintOperationRepository = mintOperationRepository;
    this.mintQuoteRepository = mintQuoteRepository;
    this.proofRepository = proofRepository;
    this.proofService = proofService;
    this.mintService = mintService;
    this.walletService = walletService;
    this.mintAdapter = mintAdapter;
    this.eventBus = eventBus;
    this.logger = logger;
    this.mintScopedLock = mintScopedLock ?? new MintScopedLock();
  }

  private buildDeps() {
    return {
      mintQuoteRepository: this.mintQuoteRepository,
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
    return this.operationIdLock.acquire(operationId);
  }

  isOperationLocked(operationId: string): boolean {
    return this.operationIdLock.isLocked(operationId);
  }

  isRecoveryInProgress(): boolean {
    return this.recoveryLock !== null;
  }

  async init(
    mintUrl: string,
    quoteId: string,
    method: MintMethod = 'bolt11',
    methodData: MintMethodData = {},
  ): Promise<InitMintOperation> {
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    const quote = await this.mintQuoteRepository.getMintQuote(mintUrl, quoteId);
    if (!quote) {
      throw new Error(`Mint quote ${quoteId} not found for mint ${mintUrl}`);
    }
    if (!quote.amount || quote.amount <= 0) {
      throw new ProofValidationError(`Mint quote ${quoteId} has invalid amount`);
    }

    const operationId = generateSubId();
    const operation = createMintOperation(operationId, mintUrl, quoteId, {
      method,
      methodData,
    } as MintMethodMeta);

    await this.mintOperationRepository.create(operation);
    this.logger?.debug('Mint operation created', { operationId, mintUrl, quoteId, method });

    return operation;
  }

  async prepare(operationId: string): Promise<PreparedMintOperation> {
    const releaseLock = await this.acquireOperationLock(operationId);
    let releaseMintLock: (() => void) | null = null;
    let initOp: InitMintOperation | null = null;
    let failure: unknown;
    try {
      const operation = await this.mintOperationRepository.getById(operationId);
      if (!operation || operation.state !== 'init') {
        throw new Error(
          `Cannot prepare operation ${operationId}: expected state 'init' but found '${
            operation?.state ?? 'not found'
          }'`,
        );
      }

      initOp = operation as InitMintOperation;
      releaseMintLock = await this.mintScopedLock.acquire(initOp.mintUrl);
      try {
        const handler = this.handlerProvider.get(initOp.method);
        const { wallet } = await this.walletService.getWalletWithActiveKeysetId(initOp.mintUrl);
        const prepared = await handler.prepare({
          ...this.buildDeps(),
          operation: initOp as any,
          wallet,
        });

        const preparedOp: PreparedMintOperation = {
          ...prepared,
          state: 'prepared',
          updatedAt: Date.now(),
        };

        await this.mintOperationRepository.update(preparedOp);
        await this.eventBus.emit('mint-op:prepared', {
          mintUrl: preparedOp.mintUrl,
          operationId: preparedOp.id,
          operation: preparedOp,
        });

        this.logger?.info('Mint operation prepared', {
          operationId: preparedOp.id,
          mintUrl: preparedOp.mintUrl,
          quoteId: preparedOp.quoteId,
          method: preparedOp.method,
        });

        return preparedOp;
      } catch (e) {
        failure = e;
      } finally {
        releaseMintLock?.();
      }
    } finally {
      releaseLock();
    }
    if (failure) {
      if (initOp) {
        await this.tryRecoverInitOperation(initOp);
      }
      throw failure;
    }
    throw new Error(`Failed to prepare operation ${operationId}`);
  }

  async execute(operationId: string): Promise<FinalizedMintOperation> {
    const releaseLock = await this.acquireOperationLock(operationId);
    try {
      const operation = await this.mintOperationRepository.getById(operationId);
      if (!operation || operation.state !== 'prepared') {
        throw new Error(
          `Cannot execute operation ${operationId}: expected state 'prepared' but found '${
            operation?.state ?? 'not found'
          }'`,
        );
      }

      const preparedOp = operation as PreparedMintOperation;
      const executing: ExecutingMintOperation = {
        ...preparedOp,
        state: 'executing',
        updatedAt: Date.now(),
      };
      await this.mintOperationRepository.update(executing);

      await this.eventBus.emit('mint-op:executing', {
        mintUrl: executing.mintUrl,
        operationId: executing.id,
        operation: executing,
      });

      try {
        const handler = this.handlerProvider.get(executing.method);
        const { wallet } = await this.walletService.getWalletWithActiveKeysetId(executing.mintUrl);
        const result = await handler.execute({
          ...this.buildDeps(),
          operation: executing as any,
          wallet,
        });

        switch (result.status) {
          case 'ISSUED':
            if (!(await this.ensureOutputsSaved(executing, result.proofs))) {
              throw new Error(`Failed to persist output proofs for operation ${executing.id}`);
            }
            return await this.finalizeIssuedOperation(executing);
          case 'ALREADY_ISSUED':
            if (!(await this.ensureOutputsSaved(executing))) {
              await this.markAsRolledBack(
                executing,
                `Recovered issued quote ${executing.quoteId} but no proofs could be restored`,
              );
              throw new Error(
                `Failed to recover proofs for already-issued operation ${executing.id}`,
              );
            }
            return await this.finalizeIssuedOperation(executing);
          case 'FAILED':
            throw new Error(result.error ?? 'Mint execution failed');
        }
      } catch (e) {
        await this.tryRecoverExecutingOperation(executing);

        const current = await this.mintOperationRepository.getById(operationId);
        if (current?.state === 'finalized') {
          return current as FinalizedMintOperation;
        }

        throw e;
      }
    } finally {
      releaseLock();
    }
  }

  async redeem(mintUrl: string, quoteId: string): Promise<FinalizedMintOperation | null> {
    const quote = await this.mintQuoteRepository.getMintQuote(mintUrl, quoteId);
    if (!quote) {
      throw new Error(`Mint quote ${quoteId} not found for mint ${mintUrl}`);
    }

    const existing = await this.getOperationByQuote(mintUrl, quoteId);
    if (existing) {
      let latestState = existing.state;

      if (existing.state === 'finalized') {
        return existing as FinalizedMintOperation;
      }

      if (existing.state === 'init') {
        const prepared = await this.prepare(existing.id);
        return this.execute(prepared.id);
      }

      if (existing.state === 'prepared') {
        return this.execute(existing.id);
      }

      if (existing.state === 'executing') {
        await this.recoverExecutingOperation(existing as ExecutingMintOperation);
        const recovered = await this.mintOperationRepository.getById(existing.id);
        if (recovered?.state === 'finalized') {
          return recovered as FinalizedMintOperation;
        }
        latestState = recovered?.state ?? existing.state;
        if (recovered && recovered.state !== 'rolled_back') {
          this.logger?.warn('Mint operation still active after recovery attempt', {
            operationId: recovered.id,
            state: recovered.state,
            mintUrl: recovered.mintUrl,
            quoteId: recovered.quoteId,
          });
          throw new NetworkError(
            `Mint operation ${recovered.id} still executing after recovery attempt`,
          );
        }
      }

      if (latestState !== 'rolled_back') {
        this.logger?.warn('Mint operation is active; refusing to create a duplicate', {
          operationId: existing.id,
          state: latestState,
          mintUrl: existing.mintUrl,
          quoteId: existing.quoteId,
        });
        throw new NetworkError(`Mint operation ${existing.id} still active after recovery attempt`);
      }
    }

    if (quote.state === 'ISSUED') {
      this.logger?.info('Mint quote already in ISSUED state, skipping redeem', {
        mintUrl,
        quoteId,
      });
      return null;
    }

    const initOp = await this.init(mintUrl, quoteId, 'bolt11', {});
    const preparedOp = await this.prepare(initOp.id);
    return this.execute(preparedOp.id);
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
      let initCount = 0;
      let preparedCount = 0;
      let executingCount = 0;

      const initOps = await this.mintOperationRepository.getByState('init');
      for (const op of initOps) {
        try {
          await this.recoverInitOperation(op as InitMintOperation);
          initCount++;
        } catch (e) {
          if (e instanceof OperationInProgressError) {
            this.logger?.debug('Mint init operation in progress, skipping recovery', {
              operationId: op.id,
            });
            continue;
          }
          this.logger?.warn('Failed to recover mint init operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const preparedOps = await this.mintOperationRepository.getByState('prepared');
      for (const op of preparedOps) {
        try {
          await this.execute(op.id);
          preparedCount++;
        } catch (e) {
          this.logger?.warn('Failed to execute stale prepared mint operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const executingOps = await this.mintOperationRepository.getByState('executing');
      for (const op of executingOps) {
        try {
          await this.recoverExecutingOperation(op as ExecutingMintOperation);
          executingCount++;
        } catch (e) {
          if (e instanceof OperationInProgressError) {
            this.logger?.debug('Mint executing operation in progress, skipping recovery', {
              operationId: op.id,
            });
            continue;
          }

          this.logger?.error('Error recovering executing mint operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      this.logger?.info('Mint operation recovery completed', {
        initOperations: initCount,
        preparedOperations: preparedCount,
        executingOperations: executingCount,
      });
    } finally {
      this.recoveryLock = null;
      releaseRecoveryLock!();
    }
  }

  async recoverExecutingOperation(
    op: ExecutingMintOperation,
    options?: { skipLock?: boolean },
  ): Promise<void> {
    const releaseLock = options?.skipLock ? undefined : await this.acquireOperationLock(op.id);
    try {
      const current = await this.mintOperationRepository.getById(op.id);
      if (!current) {
        this.logger?.warn('Mint operation missing during recovery', { operationId: op.id });
        return;
      }

      if (current.state === 'finalized' || current.state === 'rolled_back') {
        return;
      }

      if (current.state !== 'executing') {
        this.logger?.debug('Mint operation not executing during recovery', {
          operationId: current.id,
          state: current.state,
        });
        return;
      }

      const executing = current as ExecutingMintOperation;

      if (await this.hasSavedOutputs(executing)) {
        await this.finalizeIssuedOperation(executing);
        return;
      }

      const handler = this.handlerProvider.get(executing.method);
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(executing.mintUrl);
      const result = await handler.recoverExecuting({
        ...this.buildDeps(),
        operation: executing as any,
        wallet,
      });

      switch (result.status) {
        case 'FINALIZED': {
          if (await this.ensureOutputsSaved(executing)) {
            await this.finalizeIssuedOperation(executing);
          } else {
            await this.markAsRolledBack(
              executing,
              `Recovered issued quote ${executing.quoteId} but no proofs could be restored`,
            );
          }
          break;
        }
        case 'ROLLED_BACK': {
          await this.markAsRolledBack(executing, result.error);
          break;
        }
        case 'STAY_EXECUTING': {
          this.logger?.warn('Mint operation remains executing; will retry recovery later', {
            operationId: executing.id,
            mintUrl: executing.mintUrl,
            quoteId: executing.quoteId,
          });
          break;
        }
      }
    } finally {
      if (releaseLock) {
        releaseLock();
      }
    }
  }

  async getOperation(operationId: string): Promise<MintOperation | null> {
    return this.mintOperationRepository.getById(operationId);
  }

  async getOperationByQuote(mintUrl: string, quoteId: string): Promise<MintOperation | null> {
    const operations = await this.mintOperationRepository.getByQuoteId(mintUrl, quoteId);
    if (operations.length === 0) {
      return null;
    }

    const sorted = operations.sort((a, b) => b.updatedAt - a.updatedAt);

    const finalized = sorted.find((op) => op.state === 'finalized');
    if (finalized) {
      return finalized;
    }

    const active = sorted.find((op) => op.state !== 'rolled_back');
    return active ?? sorted[0] ?? null;
  }

  async getPendingOperations(): Promise<MintOperation[]> {
    return this.mintOperationRepository.getPending();
  }

  private async recoverInitOperation(op: InitMintOperation): Promise<void> {
    const releaseLock = await this.acquireOperationLock(op.id);
    try {
      const current = await this.mintOperationRepository.getById(op.id);
      if (!current || current.state !== 'init') {
        return;
      }

      await this.mintOperationRepository.delete(op.id);
      this.logger?.info('Cleaned up failed mint init operation', { operationId: op.id });
    } finally {
      releaseLock();
    }
  }

  private async tryRecoverInitOperation(op: InitMintOperation): Promise<void> {
    try {
      await this.recoverInitOperation(op);
      this.logger?.info('Recovered mint init operation after failure', { operationId: op.id });
    } catch (recoveryError) {
      this.logger?.warn('Failed to recover mint init operation, will retry on startup', {
        operationId: op.id,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
    }
  }

  private async tryRecoverExecutingOperation(op: ExecutingMintOperation): Promise<void> {
    try {
      await this.recoverExecutingOperation(op, { skipLock: true });
      this.logger?.info('Recovered executing mint operation after failure', {
        operationId: op.id,
      });
    } catch (recoveryError) {
      this.logger?.warn('Failed to recover executing mint operation, will retry on startup', {
        operationId: op.id,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
    }
  }

  private async ensureOutputsSaved(
    op: ExecutingMintOperation,
    proofsFromExecute?: Proof[],
  ): Promise<boolean> {
    if (await this.hasSavedOutputs(op)) {
      return true;
    }

    if (proofsFromExecute && proofsFromExecute.length > 0) {
      await this.proofService.saveProofs(
        op.mintUrl,
        mapProofToCoreProof(op.mintUrl, 'ready', proofsFromExecute, {
          createdByOperationId: op.id,
        }),
      );
    }

    if (await this.hasSavedOutputs(op)) {
      return true;
    }

    await this.proofService.recoverProofsFromOutputData(op.mintUrl, op.outputData, {
      createdByOperationId: op.id,
    });

    return this.hasSavedOutputs(op);
  }

  private async finalizeIssuedOperation(
    op: ExecutingMintOperation,
  ): Promise<FinalizedMintOperation> {
    const current = await this.mintOperationRepository.getById(op.id);
    if (!current) {
      throw new Error(`Operation ${op.id} not found`);
    }

    if (current.state === 'finalized') {
      return current as FinalizedMintOperation;
    }

    if (current.state === 'rolled_back') {
      throw new Error(`Cannot finalize operation ${op.id} in state ${current.state}`);
    }

    if (current.state !== 'executing') {
      throw new Error(`Cannot finalize operation ${op.id} in state ${current.state}`);
    }

    const quote = await this.mintQuoteRepository.getMintQuote(current.mintUrl, current.quoteId);
    if (!quote) {
      throw new Error(`Mint quote ${current.quoteId} not found for mint ${current.mintUrl}`);
    }

    if (quote.state !== 'ISSUED') {
      await this.mintQuoteRepository.setMintQuoteState(current.mintUrl, current.quoteId, 'ISSUED');
      await this.eventBus.emit('mint-quote:state-changed', {
        mintUrl: current.mintUrl,
        quoteId: current.quoteId,
        state: 'ISSUED',
      });
    }

    await this.eventBus.emit('mint-quote:redeemed', {
      mintUrl: current.mintUrl,
      quoteId: current.quoteId,
      quote: { ...quote, state: 'ISSUED' },
    });

    const finalized: FinalizedMintOperation = {
      ...(current as PreparedOrLaterOperation),
      state: 'finalized',
      updatedAt: Date.now(),
    };

    await this.mintOperationRepository.update(finalized);

    await this.eventBus.emit('mint-op:finalized', {
      mintUrl: finalized.mintUrl,
      operationId: finalized.id,
      operation: finalized,
    });

    this.logger?.info('Mint operation finalized', {
      operationId: finalized.id,
      mintUrl: finalized.mintUrl,
      quoteId: finalized.quoteId,
    });

    return finalized;
  }

  private async markAsRolledBack(op: PreparedOrLaterOperation, error: string): Promise<void> {
    const rolledBack = {
      ...op,
      state: 'rolled_back' as const,
      updatedAt: Date.now(),
      error,
    };

    await this.mintOperationRepository.update(rolledBack);
    await this.eventBus.emit('mint-op:rolled-back', {
      mintUrl: op.mintUrl,
      operationId: op.id,
      operation: rolledBack,
    });

    this.logger?.warn('Mint operation rolled back', {
      operationId: op.id,
      mintUrl: op.mintUrl,
      quoteId: op.quoteId,
      error,
    });
  }

  private async hasSavedOutputs(op: PreparedOrLaterOperation): Promise<boolean> {
    if (!hasPreparedData(op)) {
      return false;
    }

    const outputSecrets = getOutputProofSecrets(op);
    if (outputSecrets.length === 0) {
      return false;
    }

    for (const secret of outputSecrets) {
      const proof = await this.proofRepository.getProofBySecret(op.mintUrl, secret);
      if (!proof) {
        return false;
      }
    }

    return true;
  }
}
