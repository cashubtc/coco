import type { Proof } from '@cashu/cashu-ts';
import type {
  MintBatchAttemptRepository,
  MintOperationRepository,
  ProofRepository,
} from '../../repositories';
import type {
  ExecutingMintOperation,
  FailedMintOperation,
  FinalizedMintOperation,
  InitMintOperation,
  MintOperation,
  PendingMintOperation,
  PendingOrLaterOperation,
  TerminalMintOperation,
} from './MintOperation';
import type { MintBatchAttempt } from './MintBatchAttempt';
import {
  createMintOperation,
  getOutputProofSecrets,
  hasPendingData,
  isTerminalOperation,
} from './MintOperation';
import type {
  MintMethod,
  MintMethodData,
  MintMethodMeta,
  PendingMintCheckResult,
  MintMethodQuoteSnapshot,
  MintMethodRemoteState,
} from './MintMethodHandler';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import {
  generateSubId,
  getSecretsFromSerializedOutputData,
  mapProofToCoreProof,
  sumAmounts,
} from '../../utils';
import {
  OperationInProgressError,
  NetworkError,
  ProofValidationError,
  UnknownMintError,
} from '../../models/Error';
import { normalizeUnitAmount, type UnitAmount } from '../../amounts.ts';
import type { MintAdapter } from '../../infra';
import type { MintHandlerProvider } from '../../infra/handlers/mint';
import { MintScopedLock } from '../MintScopedLock';
import { OperationIdLock } from '../OperationIdLock';

/**
 * MintOperationService orchestrates mint quote redemption as a crash-safe saga.
 */
export class MintOperationService {
  private readonly handlerProvider: MintHandlerProvider;
  private readonly mintOperationRepository: MintOperationRepository;
  private readonly mintBatchAttemptRepository: MintBatchAttemptRepository;
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
    mintBatchAttemptRepository: MintBatchAttemptRepository,
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
    this.mintBatchAttemptRepository = mintBatchAttemptRepository;
    this.proofRepository = proofRepository;
    this.proofService = proofService;
    this.mintService = mintService;
    this.walletService = walletService;
    this.mintAdapter = mintAdapter;
    this.eventBus = eventBus;
    this.logger = logger;
    this.mintScopedLock = mintScopedLock ?? new MintScopedLock();

    this.eventBus.on('mint-op:quote-state-changed', async ({ operationId, operation, state }) => {
      if (operation.state !== 'pending') {
        return;
      }

      await this.recordPendingObservation(
        operationId,
        state,
        operation.lastObservedRemoteStateAt ?? Date.now(),
      );
    });
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
    intent: UnitAmount,
    method: MintMethod = 'bolt11',
    methodData: MintMethodData = {},
    options?: { quoteId?: string },
  ): Promise<InitMintOperation> {
    const parsed = normalizeUnitAmount(intent);
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    if (parsed.amount.isZero()) {
      throw new ProofValidationError('Amount must be a positive number');
    }

    const operationId = generateSubId();
    const operation = createMintOperation(
      operationId,
      mintUrl,
      {
        method,
        methodData,
      } as MintMethodMeta,
      parsed,
      options,
    );

    await this.mintOperationRepository.create(operation);
    this.logger?.debug('Mint operation created', {
      operationId,
      mintUrl,
      quoteId: options?.quoteId,
      method,
      amount: parsed.amount,
      unit: parsed.unit,
    });

    return operation;
  }

  async prepareNewQuote(
    mintUrl: string,
    intent: UnitAmount,
    method: MintMethod = 'bolt11',
    methodData: MintMethodData = {},
  ): Promise<PendingMintOperation> {
    const initOperation = await this.init(mintUrl, normalizeUnitAmount(intent), method, methodData);
    return this.prepare(initOperation.id);
  }

  async importQuote(
    mintUrl: string,
    quote: MintMethodQuoteSnapshot,
    method: MintMethod = 'bolt11',
    methodData: MintMethodData = {},
    options?: { skipMintLock?: boolean },
  ): Promise<PendingMintOperation> {
    if (!quote.amount || quote.amount.isZero()) {
      throw new ProofValidationError(`Mint quote ${quote.quote} has invalid amount`);
    }

    const existing = await this.getOperationByQuote(mintUrl, quote.quote);
    if (existing?.state === 'pending') {
      return existing;
    }
    if (existing?.state === 'init') {
      return this.prepare(existing.id, {
        importedQuote: quote,
        skipMintLock: options?.skipMintLock,
      });
    }
    if (existing) {
      throw new Error(
        `Mint quote ${quote.quote} is already tracked by operation ${existing.id} in state ${existing.state}`,
      );
    }

    const initOperation = await this.init(
      mintUrl,
      { amount: quote.amount, unit: quote.unit },
      method,
      methodData,
      { quoteId: quote.quote },
    );

    return this.prepare(initOperation.id, {
      importedQuote: quote,
      skipMintLock: options?.skipMintLock,
    });
  }

  async prepare(
    operationId: string,
    options?: {
      skipMintLock?: boolean;
      importedQuote?: MintMethodQuoteSnapshot;
    },
  ): Promise<PendingMintOperation> {
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
      if (!options?.skipMintLock) {
        releaseMintLock = await this.mintScopedLock.acquire(initOp.mintUrl);
      }
      try {
        const handler = this.handlerProvider.get(initOp.method);
        await this.mintService.assertMethodUnitSupported(initOp.mintUrl, 4, initOp.method, {
          amount: initOp.amount,
          unit: initOp.unit,
        });
        const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
          initOp.mintUrl,
          initOp.unit,
        );
        const pending = await handler.prepare({
          ...this.buildDeps(),
          operation: initOp as any,
          wallet,
          importedQuote: options?.importedQuote as any,
        });

        const batchSupport = handler.assessBatchSupport
          ? await handler.assessBatchSupport({
              ...this.buildDeps(),
              operation: pending as any,
              wallet,
            })
          : { supported: false };
        const pendingOp: PendingMintOperation = {
          ...pending,
          state: 'pending',
          batchEligible: batchSupport.supported,
          updatedAt: Date.now(),
        };

        await this.mintOperationRepository.update(pendingOp);
        await this.eventBus.emit('mint-op:pending', {
          mintUrl: pendingOp.mintUrl,
          operationId: pendingOp.id,
          operation: pendingOp,
        });

        this.logger?.info('Mint operation is pending', {
          operationId: pendingOp.id,
          mintUrl: pendingOp.mintUrl,
          quoteId: pendingOp.quoteId,
          method: pendingOp.method,
        });

        return pendingOp;
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

  async execute(operationId: string): Promise<TerminalMintOperation> {
    const releaseLock = await this.acquireOperationLock(operationId);
    try {
      const operation = await this.mintOperationRepository.getById(operationId);
      if (!operation || operation.state !== 'pending') {
        throw new Error(
          `Cannot execute operation ${operationId}: expected state 'pending' but found '${
            operation?.state ?? 'not found'
          }'`,
        );
      }

      let pendingOp = operation as PendingMintOperation;
      const handler = this.handlerProvider.get(pendingOp.method);
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
        pendingOp.mintUrl,
        pendingOp.unit,
      );

      if (!pendingOp.outputData) {
        if (!handler.prepareSingleOutput) {
          throw new Error(
            `Mint method ${pendingOp.method} cannot prepare output data for operation ${pendingOp.id}`,
          );
        }

        pendingOp = {
          ...(await handler.prepareSingleOutput({
            ...this.buildDeps(),
            operation: pendingOp as any,
            wallet,
          })),
          updatedAt: Date.now(),
        } as PendingMintOperation;
        await this.mintOperationRepository.update(pendingOp);
      }

      if (!pendingOp.outputData) {
        throw new Error(`Mint operation ${pendingOp.id} has no output data after preparation`);
      }

      const executing: ExecutingMintOperation = {
        ...pendingOp,
        outputData: pendingOp.outputData,
        state: 'executing',
        updatedAt: Date.now(),
        error: undefined,
      };
      await this.mintOperationRepository.update(executing);

      await this.eventBus.emit('mint-op:executing', {
        mintUrl: executing.mintUrl,
        operationId: executing.id,
        operation: executing,
      });

      try {
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
          case 'ALREADY_ISSUED': {
            const proofsRecovered = await this.ensureOutputsSaved(executing);
            const error = proofsRecovered
              ? undefined
              : `Recovered issued quote ${executing.quoteId} but no proofs could be restored`;

            if (error) {
              this.logger?.warn('Mint quote was already issued but proofs could not be recovered', {
                operationId: executing.id,
                mintUrl: executing.mintUrl,
                quoteId: executing.quoteId,
              });
            }

            return await this.finalizeIssuedOperation(executing, error);
          }
          case 'FAILED':
            throw new Error(result.error ?? 'Mint execution failed');
        }
      } catch (e) {
        await this.tryRecoverExecutingOperation(executing);

        const current = await this.mintOperationRepository.getById(operationId);
        if (current && isTerminalOperation(current)) {
          return current;
        }

        throw e;
      }
    } finally {
      releaseLock();
    }
  }

  async finalize(operationId: string): Promise<TerminalMintOperation> {
    const operation = await this.mintOperationRepository.getById(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    if (isTerminalOperation(operation)) {
      this.logger?.debug('Operation already finalized', { operationId });
      return operation;
    }

    if (operation.state === 'pending') {
      return this.execute(operation.id);
    }

    if (operation.state === 'executing') {
      await this.recoverExecutingOperation(operation as ExecutingMintOperation);
      const updated = await this.mintOperationRepository.getById(operationId);
      if (updated && isTerminalOperation(updated)) {
        return updated;
      }
      if (updated?.state === 'pending') {
        throw new Error(`Operation ${operationId} remains pending after recovery`);
      }
      throw new Error(
        `Unable to finalize operation ${operationId} in state '${updated?.state ?? 'missing'}'`,
      );
    }

    throw new Error(
      `Cannot finalize operation ${operationId} in state '${operation.state}'. Expected 'pending' or 'executing'.`,
    );
  }

  async finalizeBatch(operationIds: string[]): Promise<TerminalMintOperation[]> {
    const uniqueOperationIds = Array.from(new Set(operationIds)).sort();
    if (uniqueOperationIds.length === 0) {
      return [];
    }

    const releaseLocks: Array<() => void> = [];
    let releaseMintLock: (() => void) | null = null;
    try {
      for (const operationId of uniqueOperationIds) {
        releaseLocks.push(await this.acquireOperationLock(operationId));
      }

      const loaded = await Promise.all(
        uniqueOperationIds.map((operationId) => this.mintOperationRepository.getById(operationId)),
      );
      if (loaded.some((operation) => !operation || operation.state !== 'pending')) {
        throw new Error('Cannot batch finalize: every operation must be pending');
      }

      const operations = loaded as PendingMintOperation[];
      const [first] = operations;
      if (!first) {
        return [];
      }

      releaseMintLock = await this.mintScopedLock.acquire(first.mintUrl);

      for (const operation of operations) {
        if (operation.mintUrl !== first.mintUrl) {
          throw new Error('Cannot batch finalize operations from different mints');
        }
        if (operation.method !== first.method) {
          throw new Error('Cannot batch finalize operations with different methods');
        }
        if (operation.unit !== first.unit) {
          throw new Error('Cannot batch finalize operations with different units');
        }
        if (!operation.batchEligible || operation.outputData || operation.redeemedByBatchId) {
          throw new Error(`Operation ${operation.id} is not eligible for optimized batch minting`);
        }
        if (operation.lastObservedRemoteState !== 'PAID') {
          throw new Error(`Operation ${operation.id} is not paid`);
        }
      }

      if (!(await this.mintService.isTrustedMint(first.mintUrl))) {
        throw new UnknownMintError(`Mint ${first.mintUrl} is not trusted`);
      }

      const capability = await this.mintService.getMintBatchCapability(first.mintUrl, first.method);
      if (!capability.supported) {
        throw new Error(`Mint ${first.mintUrl} does not support batch minting for ${first.method}`);
      }
      if (operations.length > capability.maxBatchSize) {
        throw new Error(`Batch size ${operations.length} exceeds max ${capability.maxBatchSize}`);
      }

      const quoteSnapshots = await Promise.all(
        operations.map((operation) =>
          this.mintAdapter.checkMintQuoteState(first.mintUrl, operation.quoteId),
        ),
      );
      const quoteAmounts = operations.map((operation, index) => {
        const quote = quoteSnapshots[index];
        if (!quote || quote.quote !== operation.quoteId) {
          throw new Error(`Mint returned unexpected quote snapshot for ${operation.quoteId}`);
        }
        if (quote.state !== 'PAID') {
          throw new Error(`Quote ${operation.quoteId} is not PAID`);
        }
        if (!quote.amount || quote.amount.isZero()) {
          throw new Error(`Quote ${operation.quoteId} has invalid amount`);
        }
        return quote.amount;
      });

      const handler = this.handlerProvider.get(first.method);
      if (!handler.prepareBatch || !handler.executeBatch) {
        throw new Error(`Mint method ${first.method} does not implement batch minting`);
      }

      const { wallet, keysetId } = await this.walletService.getWalletWithActiveKeysetId(
        first.mintUrl,
        first.unit,
      );
      const totalAmount = sumAmounts(quoteAmounts);
      let attempt = await handler.prepareBatch({
        ...this.buildDeps(),
        operations: operations as any,
        totalAmount,
        quoteAmounts,
        wallet,
        keysetId,
      });

      await this.mintBatchAttemptRepository.create(attempt);
      for (const operation of operations) {
        await this.mintOperationRepository.update({
          ...operation,
          redeemedByBatchId: attempt.id,
          updatedAt: Date.now(),
        });
      }

      attempt = {
        ...attempt,
        state: 'requesting',
        requestedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.mintBatchAttemptRepository.update(attempt);

      const result = await handler.executeBatch({
        ...this.buildDeps(),
        attempt: attempt as any,
        operations: operations as any,
        wallet,
      });

      switch (result.status) {
        case 'ISSUED':
          await this.proofService.saveProofs(
            attempt.mintUrl,
            mapProofToCoreProof(attempt.mintUrl, 'ready', result.proofs, {
              unit: attempt.unit,
              createdByBatchId: attempt.id,
            }),
          );
          return this.finalizeIssuedBatchAttempt(attempt);
        case 'ALREADY_ISSUED':
          return this.recoverRequestingBatchAttempt(attempt);
        case 'FAILED':
          throw new Error(result.error ?? 'Batch mint execution failed');
      }
      throw new Error('Unexpected batch mint execution result');
    } finally {
      releaseMintLock?.();
      for (const release of releaseLocks.reverse()) {
        release();
      }
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
      let initCount = 0;
      let pendingCount = 0;
      let executingCount = 0;
      let batchAttemptCount = 0;

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

      const pendingOps = await this.mintOperationRepository.getByState('pending');
      for (const op of pendingOps) {
        try {
          if (await this.mintService.isTrustedMint(op.mintUrl)) {
            await this.checkPendingOperation(op.id);
            pendingCount++;
          } else {
            this.logger?.warn('Skipping recovery of pending operation for untrusted mint', {
              operationId: op.id,
              mintUrl: op.mintUrl,
            });
          }
        } catch (e) {
          this.logger?.warn('Failed to reconcile stale pending mint operation', {
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

      const batchAttempts = await this.mintBatchAttemptRepository.getPending();
      for (const attempt of batchAttempts) {
        try {
          if (attempt.state === 'requesting' || attempt.state === 'recovering') {
            await this.recoverRequestingBatchAttempt(attempt);
            batchAttemptCount++;
          } else if (attempt.state === 'prepared') {
            await this.mintBatchAttemptRepository.delete(attempt.id);
            for (const operationId of attempt.operationIds) {
              const operation = await this.mintOperationRepository.getById(operationId);
              if (operation?.state === 'pending' && operation.redeemedByBatchId === attempt.id) {
                await this.mintOperationRepository.update({
                  ...operation,
                  redeemedByBatchId: undefined,
                  updatedAt: Date.now(),
                });
              }
            }
            batchAttemptCount++;
          }
        } catch (e) {
          this.logger?.error('Error recovering mint batch attempt', {
            batchAttemptId: attempt.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      this.logger?.info('Mint operation recovery completed', {
        initOperations: initCount,
        pendingOperations: pendingCount,
        executingOperations: executingCount,
        batchAttempts: batchAttemptCount,
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

      if (isTerminalOperation(current)) {
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

      if (!(await this.mintService.isTrustedMint(executing.mintUrl))) {
        this.logger?.warn('Mint is not trusted, skipping recovery of executing mint operation', {
          operationId: executing.id,
          mintUrl: executing.mintUrl,
          quoteId: executing.quoteId,
        });
        return;
      }

      const handler = this.handlerProvider.get(executing.method);
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
        executing.mintUrl,
        executing.unit,
      );
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
            await this.transitionToPending(
              executing,
              `Recovered issued quote ${executing.quoteId} but no proofs could be restored`,
            );
          }
          break;
        }
        case 'PENDING': {
          await this.transitionToPending(executing, result.error);
          this.logger?.warn('Mint operation returned to pending after recovery', {
            operationId: executing.id,
            mintUrl: executing.mintUrl,
            quoteId: executing.quoteId,
            error: result.error,
          });
          break;
        }
        case 'TERMINAL': {
          await this.failOperation(executing, result.error);
          this.logger?.warn('Mint operation moved to failed during recovery', {
            operationId: executing.id,
            mintUrl: executing.mintUrl,
            quoteId: executing.quoteId,
            error: result.error,
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

    const terminal = sorted.find((op) => isTerminalOperation(op));
    if (terminal) {
      return terminal;
    }

    return sorted[0] ?? null;
  }

  async getInFlightOperations(): Promise<MintOperation[]> {
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

  async getPendingOperations(): Promise<PendingMintOperation[]> {
    const ops = await this.mintOperationRepository.getByState('pending');
    return ops.filter((op): op is PendingMintOperation => op.state === 'pending');
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
          unit: op.unit,
          createdByOperationId: op.id,
        }),
      );
    }

    if (await this.hasSavedOutputs(op)) {
      return true;
    }

    await this.proofService.recoverProofsFromOutputData(op.mintUrl, op.outputData, {
      unit: op.unit,
      createdByOperationId: op.id,
    });

    return this.hasSavedOutputs(op);
  }

  private async finalizeIssuedOperation(
    op: ExecutingMintOperation,
    error?: string,
  ): Promise<FinalizedMintOperation> {
    const current = await this.mintOperationRepository.getById(op.id);
    if (!current) {
      throw new Error(`Operation ${op.id} not found`);
    }

    if (current.state === 'finalized') {
      return current as FinalizedMintOperation;
    }

    if (current.state !== 'executing') {
      throw new Error(`Cannot finalize operation ${op.id} in state ${current.state}`);
    }

    const observedRemoteStateAt = Date.now();

    await this.eventBus.emit('mint-op:quote-state-changed', {
      mintUrl: current.mintUrl,
      operationId: current.id,
      operation: current,
      quoteId: current.quoteId,
      state: 'ISSUED',
    });

    const finalized: FinalizedMintOperation = {
      ...(current as PendingOrLaterOperation),
      state: 'finalized',
      lastObservedRemoteState: 'ISSUED',
      lastObservedRemoteStateAt: observedRemoteStateAt,
      updatedAt: Date.now(),
      error,
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

  private async failOperation(
    op: ExecutingMintOperation,
    error: string,
  ): Promise<FailedMintOperation> {
    const current = await this.mintOperationRepository.getById(op.id);
    if (!current) {
      throw new Error(`Operation ${op.id} not found`);
    }

    if (current.state === 'failed') {
      return current as FailedMintOperation;
    }

    if (current.state === 'finalized') {
      throw new Error(`Cannot fail operation ${op.id} in state ${current.state}`);
    }

    if (current.state !== 'executing') {
      throw new Error(`Cannot fail operation ${op.id} in state ${current.state}`);
    }

    const failed: FailedMintOperation = {
      ...(current as PendingOrLaterOperation),
      state: 'failed',
      updatedAt: Date.now(),
      error,
      terminalFailure: {
        reason: error,
        observedAt: Date.now(),
      },
    };

    await this.mintOperationRepository.update(failed);

    await this.eventBus.emit('mint-op:finalized', {
      mintUrl: failed.mintUrl,
      operationId: failed.id,
      operation: failed,
    });

    this.logger?.info('Mint operation failed during recovery', {
      operationId: failed.id,
      mintUrl: failed.mintUrl,
      quoteId: failed.quoteId,
      error,
    });

    return failed;
  }

  private async finalizeIssuedBatchAttempt(
    attempt: MintBatchAttempt,
    error?: string,
  ): Promise<FinalizedMintOperation[]> {
    const currentAttempt = await this.mintBatchAttemptRepository.getById(attempt.id);
    if (!currentAttempt) {
      throw new Error(`Batch attempt ${attempt.id} not found`);
    }

    const finalizedAt = Date.now();
    const finalizedAttempt: MintBatchAttempt = {
      ...currentAttempt,
      state: 'finalized',
      finalizedAt,
      updatedAt: finalizedAt,
      error,
    };
    await this.mintBatchAttemptRepository.update(finalizedAttempt);

    const finalizedOperations: FinalizedMintOperation[] = [];
    for (const operationId of finalizedAttempt.operationIds) {
      const current = await this.mintOperationRepository.getById(operationId);
      if (!current) {
        throw new Error(`Operation ${operationId} not found`);
      }
      if (current.state === 'finalized') {
        finalizedOperations.push(current as FinalizedMintOperation);
        continue;
      }
      if (current.state !== 'pending' || current.redeemedByBatchId !== finalizedAttempt.id) {
        throw new Error(`Cannot finalize batch operation ${operationId} in state ${current.state}`);
      }

      await this.eventBus.emit('mint-op:quote-state-changed', {
        mintUrl: current.mintUrl,
        operationId: current.id,
        operation: current,
        quoteId: current.quoteId,
        state: 'ISSUED',
      });

      const finalized: FinalizedMintOperation = {
        ...(current as PendingMintOperation),
        state: 'finalized',
        lastObservedRemoteState: 'ISSUED',
        lastObservedRemoteStateAt: finalizedAt,
        updatedAt: Date.now(),
        error,
      };
      await this.mintOperationRepository.update(finalized);
      await this.eventBus.emit('mint-op:finalized', {
        mintUrl: finalized.mintUrl,
        operationId: finalized.id,
        operation: finalized,
      });
      finalizedOperations.push(finalized);
    }

    return finalizedOperations;
  }

  private async recoverRequestingBatchAttempt(
    attempt: MintBatchAttempt,
  ): Promise<FinalizedMintOperation[]> {
    if (await this.hasSavedBatchOutputs(attempt)) {
      return this.finalizeIssuedBatchAttempt(attempt);
    }

    const recovered = await this.proofService.recoverProofsFromOutputData(
      attempt.mintUrl,
      attempt.outputData,
      {
        unit: attempt.unit,
        createdByBatchId: attempt.id,
      },
    );
    if (recovered.length > 0 && (await this.hasSavedBatchOutputs(attempt))) {
      return this.finalizeIssuedBatchAttempt(attempt);
    }

    const failed: MintBatchAttempt = {
      ...attempt,
      state: 'failed',
      error: `Batch attempt ${attempt.id} could not recover issued proofs`,
      updatedAt: Date.now(),
    };
    await this.mintBatchAttemptRepository.update(failed);
    throw new Error(failed.error);
  }

  private async transitionToPending(
    op: ExecutingMintOperation,
    error?: string,
  ): Promise<PendingMintOperation> {
    const pending: PendingMintOperation = {
      ...op,
      state: 'pending',
      updatedAt: Date.now(),
      error,
    };

    await this.mintOperationRepository.update(pending);
    await this.eventBus.emit('mint-op:pending', {
      mintUrl: op.mintUrl,
      operationId: op.id,
      operation: pending,
    });

    this.logger?.info('Mint operation moved to pending', {
      operationId: op.id,
      mintUrl: op.mintUrl,
      quoteId: op.quoteId,
      error,
    });

    return pending;
  }

  async observePendingOperation(operationId: string): Promise<PendingMintCheckResult> {
    const op = await this.getOperation(operationId);
    if (!op || op.state !== 'pending') {
      throw new Error(
        `Cannot check operation ${operationId}: expected state 'pending' but found '${
          op?.state ?? 'not found'
        }'`,
      );
    }
    const handler = this.handlerProvider.get(op.method);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(op.mintUrl, op.unit);

    const result = await handler.checkPending({
      ...this.buildDeps(),
      operation: op as PendingMintOperation,
      wallet,
    });

    const observedPending: PendingMintOperation = {
      ...op,
      lastObservedRemoteState: result.observedRemoteState,
      lastObservedRemoteStateAt: result.observedRemoteStateAt,
      updatedAt: Date.now(),
    };

    await this.eventBus.emit('mint-op:quote-state-changed', {
      mintUrl: observedPending.mintUrl,
      operationId: observedPending.id,
      operation: observedPending,
      quoteId: observedPending.quoteId,
      state: result.observedRemoteState,
    });

    if (result.category === 'terminal' && result.terminalFailure) {
      await this.failPendingOperation(op, result.terminalFailure);
    }

    return result;
  }

  async recordPendingObservation(
    operationId: string,
    observedRemoteState: MintMethodRemoteState,
    observedRemoteStateAt = Date.now(),
  ): Promise<PendingMintOperation> {
    const op = await this.getOperation(operationId);
    if (!op || op.state !== 'pending') {
      throw new Error(
        `Cannot record observation for operation ${operationId}: expected state 'pending' but found '${
          op?.state ?? 'not found'
        }'`,
      );
    }

    const observedPending: PendingMintOperation = {
      ...op,
      lastObservedRemoteState: observedRemoteState,
      lastObservedRemoteStateAt: observedRemoteStateAt,
      updatedAt: Date.now(),
    };
    await this.mintOperationRepository.update(observedPending);

    return observedPending;
  }

  async checkPendingOperation(operationId: string): Promise<PendingMintCheckResult> {
    const result = await this.observePendingOperation(operationId);

    if (result.category === 'ready' || result.category === 'completed') {
      await this.finalize(operationId);
    }

    return result;
  }

  private async failPendingOperation(
    op: PendingMintOperation,
    terminalFailure: FailedMintOperation['terminalFailure'],
  ): Promise<FailedMintOperation> {
    if (!terminalFailure) {
      throw new Error(`Cannot fail pending operation ${op.id} without terminal failure details`);
    }

    const current = await this.mintOperationRepository.getById(op.id);
    if (!current) {
      throw new Error(`Operation ${op.id} not found`);
    }

    if (current.state === 'failed') {
      return current as FailedMintOperation;
    }

    if (current.state === 'finalized') {
      throw new Error(`Cannot fail operation ${op.id} in state ${current.state}`);
    }

    if (current.state !== 'pending') {
      throw new Error(`Cannot fail operation ${op.id} in state ${current.state}`);
    }

    const failed: FailedMintOperation = {
      ...(current as PendingOrLaterOperation),
      state: 'failed',
      updatedAt: Date.now(),
      error: terminalFailure.reason,
      terminalFailure,
    };

    await this.mintOperationRepository.update(failed);

    await this.eventBus.emit('mint-op:finalized', {
      mintUrl: failed.mintUrl,
      operationId: failed.id,
      operation: failed,
    });

    this.logger?.info('Mint operation failed while pending', {
      operationId: failed.id,
      mintUrl: failed.mintUrl,
      quoteId: failed.quoteId,
      error: terminalFailure.reason,
    });

    return failed;
  }

  private async hasSavedOutputs(op: PendingOrLaterOperation): Promise<boolean> {
    if (!hasPendingData(op)) {
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

  private async hasSavedBatchOutputs(attempt: MintBatchAttempt): Promise<boolean> {
    const { keepSecrets, sendSecrets } = getSecretsFromSerializedOutputData(attempt.outputData);
    const outputSecrets = [...keepSecrets, ...sendSecrets];
    if (outputSecrets.length === 0) {
      return false;
    }

    for (const secret of outputSecrets) {
      const proof = await this.proofRepository.getProofBySecret(attempt.mintUrl, secret);
      if (!proof) {
        return false;
      }
    }

    return true;
  }
}
