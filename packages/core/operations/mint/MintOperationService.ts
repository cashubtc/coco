import { Amount, type Proof } from '@cashu/cashu-ts';
import type { MintOperationRepository, ProofRepository } from '../../repositories';
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
import { generateSubId, mapProofToCoreProof, normalizeMintUrl } from '../../utils';
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
import {
  getMintQuoteAvailableAmount,
  getMintQuoteAmount,
  getMintQuoteRemoteState,
  mintQuoteToMethodSnapshot,
  type MintQuote,
} from '../../models/MintQuote';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle';

/**
 * MintOperationService orchestrates mint quote redemption as a crash-safe saga.
 */
export class MintOperationService {
  private readonly handlerProvider: MintHandlerProvider;
  private readonly mintOperationRepository: MintOperationRepository;
  private readonly quoteLifecycle: QuoteLifecycle;
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
    quoteLifecycle: QuoteLifecycle,
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
    this.quoteLifecycle = quoteLifecycle;
    this.proofRepository = proofRepository;
    this.proofService = proofService;
    this.mintService = mintService;
    this.walletService = walletService;
    this.mintAdapter = mintAdapter;
    this.eventBus = eventBus;
    this.logger = logger;
    this.mintScopedLock = mintScopedLock ?? new MintScopedLock();

    this.eventBus.on('mint-quote:updated', async ({ mintUrl, method, quoteId, quote }) => {
      const remoteState = getMintQuoteRemoteState(quote);
      if (!remoteState) return;

      const operations = await this.getOperationsForQuote(mintUrl, method, quoteId);
      await Promise.all(
        operations
          .filter((operation): operation is PendingMintOperation => operation.state === 'pending')
          .map((operation) =>
            this.recordPendingObservation(
              operation.id,
              remoteState,
              quote.lastObservedRemoteStateAt ?? Date.now(),
            ),
          ),
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

  private async acquireOperationLockAfterWait(operationId: string): Promise<() => void> {
    try {
      return await this.acquireOperationLock(operationId);
    } catch (error) {
      if (!(error instanceof OperationInProgressError)) {
        throw error;
      }

      await this.operationIdLock.waitForUnlock(operationId);
      return this.acquireOperationLock(operationId);
    }
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
    const createOperation = async (operationMintUrl: string, operationQuoteId?: string) => {
      const operation = createMintOperation(
        operationId,
        operationMintUrl,
        {
          method,
          methodData,
        } as MintMethodMeta,
        parsed,
        operationQuoteId ? { quoteId: operationQuoteId } : undefined,
      );

      await this.mintOperationRepository.create(operation);
      return operation;
    };

    const operation = options?.quoteId
      ? await this.createQuoteBoundInitOperation(
          mintUrl,
          method,
          options.quoteId,
          parsed,
          createOperation,
        )
      : await createOperation(mintUrl);

    this.logger?.debug('Mint operation created', {
      operationId,
      mintUrl: operation.mintUrl,
      quoteId: operation.quoteId,
      method,
      amount: parsed.amount,
      unit: parsed.unit,
    });

    return operation;
  }

  private async createQuoteBoundInitOperation(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
    intent: UnitAmount,
    createOperation: (mintUrl: string, quoteId: string) => Promise<InitMintOperation>,
  ): Promise<InitMintOperation> {
    const releaseMintLock = await this.mintScopedLock.acquire(normalizeMintUrl(mintUrl));
    try {
      const quote = await this.resolveMintQuoteForOperationCreation(
        mintUrl,
        method,
        quoteId,
        intent,
      );
      return createOperation(quote.mintUrl, quote.quoteId);
    } finally {
      releaseMintLock();
    }
  }

  private async resolveMintQuoteForOperationCreation(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
    intent: UnitAmount,
  ): Promise<MintQuote> {
    const quote = await this.quoteLifecycle.getMintQuote(mintUrl, method, quoteId);
    if (!quote) {
      throw new Error(`Mint quote ${quoteId} for ${method} at ${mintUrl} was not found`);
    }

    if (!quote.amount.equals(intent.amount)) {
      throw new Error(
        `Mint quote ${quote.quoteId} amount ${quote.amount} does not match requested amount ${intent.amount}`,
      );
    }

    if (quote.unit !== intent.unit) {
      throw new Error(
        `Mint quote ${quote.quoteId} unit ${quote.unit} does not match requested unit ${intent.unit}`,
      );
    }

    if (!quote.reusable) {
      const existing = await this.getOperationByQuote(quote.mintUrl, method, quote.quoteId);
      if (existing) {
        throw new Error(
          `Mint quote ${quote.quoteId} is already tracked by operation ${existing.id} in state ${existing.state}`,
        );
      }
    }

    return quote;
  }

  async prepareExistingQuote(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
    methodData: MintMethodData = {},
    expectedUnit?: string,
    explicitAmount?: UnitAmount,
  ): Promise<PendingMintOperation> {
    const quote = await this.quoteLifecycle.requireMintQuoteForPrepare(
      mintUrl,
      method,
      quoteId,
      expectedUnit,
    );

    const fixedAmount = getMintQuoteAmount(quote);
    const amount = fixedAmount ?? explicitAmount?.amount;
    if (!amount) {
      throw new Error(
        `Mint quote ${quoteId} for ${method} at ${mintUrl} does not have a fixed amount; pass an explicit amount for reusable quote preparation`,
      );
    }
    if (explicitAmount && explicitAmount.unit !== quote.unit) {
      throw new ProofValidationError(
        `Mint quote ${quoteId} unit ${quote.unit} does not match requested unit ${explicitAmount.unit}`,
      );
    }

    const handler = this.handlerProvider.get(method);
    await handler.validateQuoteForPrepare?.(quote as any);

    const initOperation = await this.init(
      quote.mintUrl,
      { amount, unit: quote.unit },
      method,
      methodData,
      { quoteId: quote.quoteId },
    );

    return this.prepare(initOperation.id);
  }

  async importQuote(
    mintUrl: string,
    quote: MintMethodQuoteSnapshot,
    method: MintMethod = 'bolt11',
    methodData: MintMethodData = {},
    options?: { skipMintLock?: boolean },
  ): Promise<PendingMintOperation> {
    if (method !== 'bolt11') {
      throw new Error(`Unsupported mint quote import method ${String(method)}`);
    }

    const bolt11Quote = quote as MintMethodQuoteSnapshot<'bolt11'>;
    if (!bolt11Quote.amount || bolt11Quote.amount.isZero()) {
      throw new ProofValidationError(`Mint quote ${bolt11Quote.quote} has invalid amount`);
    }

    const imported = (await this.quoteLifecycle.importMintQuoteSnapshot(
      mintUrl,
      method,
      bolt11Quote,
    )) as MintQuote<'bolt11'>;
    const importedSnapshot = mintQuoteToMethodSnapshot(imported);

    const existing = await this.getOperationByQuote(imported.mintUrl, method, imported.quoteId);
    if (existing?.state === 'pending') {
      return existing;
    }
    if (existing?.state === 'init') {
      return this.prepare(existing.id, {
        importedQuote: importedSnapshot,
        skipMintLock: options?.skipMintLock,
      });
    }
    if (existing) {
      throw new Error(
        `Mint quote ${quote.quote} is already tracked by operation ${existing.id} in state ${existing.state}`,
      );
    }

    const initOperation = await this.init(
      imported.mintUrl,
      { amount: imported.amount, unit: imported.unit },
      method,
      methodData,
      { quoteId: imported.quoteId },
    );

    return this.prepare(initOperation.id, {
      importedQuote: importedSnapshot,
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
        const importedQuote =
          options?.importedQuote ??
          (await this.quoteLifecycle.loadMintQuoteSnapshotForOperation(initOp));
        const handler = this.handlerProvider.get(initOp.method);
        await this.mintService.assertMethodUnitSupported(
          initOp.mintUrl,
          initOp.method === 'onchain' ? 30 : 4,
          initOp.method,
          initOp.method === 'onchain'
            ? initOp.unit
            : {
                amount: initOp.amount,
                unit: initOp.unit,
              },
        );
        const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
          initOp.mintUrl,
          initOp.unit,
        );
        const pending = await handler.prepare({
          ...this.buildDeps(),
          operation: initOp as any,
          wallet,
          importedQuote: importedQuote as any,
        });

        const pendingOp: PendingMintOperation = {
          ...pending,
          state: 'pending',
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

  async execute(operationId: string): Promise<MintOperation> {
    const operation = await this.mintOperationRepository.getById(operationId);
    if (operation?.state === 'pending' && operation.method === 'onchain') {
      return this.claimReusableQuoteOperation(operation as PendingMintOperation);
    }

    return this.executeReadyOperation(operationId);
  }

  private async executeReadyOperation(operationId: string): Promise<TerminalMintOperation> {
    const releaseLock = await this.acquireOperationLockAfterWait(operationId);
    try {
      const operation = await this.mintOperationRepository.getById(operationId);
      if (!operation || operation.state !== 'pending') {
        throw new Error(
          `Cannot execute operation ${operationId}: expected state 'pending' but found '${
            operation?.state ?? 'not found'
          }'`,
        );
      }

      const pendingOp = operation as PendingMintOperation;
      const executing: ExecutingMintOperation = {
        ...pendingOp,
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
        const handler = this.handlerProvider.get(executing.method);
        const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
          executing.mintUrl,
          executing.unit,
        );
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
            await this.ensureReusableQuoteIssuanceObserved(executing);
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

  async finalize(operationId: string): Promise<MintOperation> {
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

      this.logger?.info('Mint operation recovery completed', {
        initOperations: initCount,
        pendingOperations: pendingCount,
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

  async getOperationByQuote(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
  ): Promise<MintOperation | null> {
    const operations = await this.getOperationsForQuote(mintUrl, method, quoteId);
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

  async getOperationsForQuote(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
  ): Promise<MintOperation[]> {
    return this.mintOperationRepository.getByQuoteId(mintUrl, method, quoteId);
  }

  private async claimReusableQuoteOperation(
    operation: PendingMintOperation,
  ): Promise<MintOperation> {
    const releaseQuoteLock = await this.mintScopedLock.acquire(
      this.quoteLockKey(operation.mintUrl, operation.method, operation.quoteId),
    );
    try {
      const current = await this.mintOperationRepository.getById(operation.id);
      if (!current || current.state !== 'pending') {
        if (current) return current;
        throw new Error(`Operation ${operation.id} not found`);
      }

      const pending = current as PendingMintOperation;
      const quote = await this.quoteLifecycle.getMintQuote(
        pending.mintUrl,
        pending.method,
        pending.quoteId,
      );
      if (!quote) {
        throw new Error(
          `Cannot claim operation ${pending.id}: mint quote ${pending.quoteId} for ${pending.method} at ${pending.mintUrl} was not found`,
        );
      }

      const claimable = await this.getLocallyClaimableQuoteAmount(quote, pending.id);
      if (pending.amount.greaterThan(claimable)) {
        this.logger?.info('Reusable mint quote is not sufficiently funded for operation', {
          operationId: pending.id,
          mintUrl: pending.mintUrl,
          quoteId: pending.quoteId,
          requestedAmount: pending.amount.toString(),
          claimableAmount: claimable.toString(),
        });
        return pending;
      }

      return this.executeReadyOperation(pending.id);
    } finally {
      releaseQuoteLock();
    }
  }

  private async getLocallyClaimableQuoteAmount(
    quote: MintQuote,
    targetOperationId?: string,
  ): Promise<Amount> {
    const remoteAvailable = getMintQuoteAvailableAmount(quote);
    const siblings = await this.mintOperationRepository.getByQuoteId(
      quote.mintUrl,
      quote.method,
      quote.quoteId,
    );
    const locallyReserved = siblings.reduce((total, operation) => {
      if (operation.state !== 'executing' || operation.id === targetOperationId) {
        return total;
      }

      return total.add(operation.amount);
    }, Amount.zero());

    if (remoteAvailable.lessThan(locallyReserved)) {
      return Amount.zero();
    }

    return remoteAvailable.subtract(locallyReserved);
  }

  private async ensureReusableQuoteIssuanceObserved(
    operation: ExecutingMintOperation,
  ): Promise<void> {
    if (operation.method !== 'onchain') {
      return;
    }

    const before = await this.quoteLifecycle.getMintQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    const refreshed = await this.quoteLifecycle.refreshMintQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );

    if (before?.method !== 'onchain' || refreshed.method !== 'onchain') {
      throw new Error(
        `Cannot verify onchain quote issuance for operation ${operation.id}: quote is not onchain`,
      );
    }

    const requiredIssued = before.quoteData.amountIssued.add(operation.amount);
    if (refreshed.quoteData.amountIssued.lessThan(requiredIssued)) {
      throw new Error(
        `Cannot finalize operation ${operation.id}: onchain quote ${operation.quoteId} amount_issued ${refreshed.quoteData.amountIssued} does not include redeemed amount ${operation.amount}`,
      );
    }
  }

  private quoteLockKey(mintUrl: string, method: MintMethod, quoteId: string): string {
    return `${mintUrl}::${method}::${quoteId}`;
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

  async recordQuoteObservation(
    operation: PendingOrLaterOperation,
    state: MintMethodRemoteState,
    observedAt = Date.now(),
  ): Promise<MintQuote> {
    return this.quoteLifecycle.recordMintQuoteObservation(operation, state, observedAt);
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
    await this.recordQuoteObservation(
      current as PendingOrLaterOperation,
      'ISSUED',
      observedRemoteStateAt,
    );

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

    await this.recordQuoteObservation(
      observedPending,
      result.observedRemoteState,
      result.observedRemoteStateAt,
    );

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
    const releaseLock = await this.acquireOperationLock(operationId);
    try {
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
      await this.eventBus.emit('mint-op:pending', {
        mintUrl: observedPending.mintUrl,
        operationId: observedPending.id,
        operation: observedPending,
      });

      return observedPending;
    } finally {
      releaseLock();
    }
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
}
