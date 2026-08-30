import { Amount, type StaleKeysetError, type Proof } from '@cashu/cashu-ts';
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
} from './MintMethodHandler';
import { asStaleKeysetError, type MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { ProofService } from '../../services/ProofService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import { generateSubId, mapProofToCoreProof, normalizeMintUrl } from '../../utils';
import {
  OperationInProgressError,
  ProofValidationError,
  UnknownMintError,
} from '../../models/Error';
import { normalizeUnitAmount, type UnitAmount } from '../../amounts.ts';
import type { MintAdapter } from '../../infra';
import type { MintHandlerProvider } from '../../infra/handlers/mint';
import { MintScopedLock } from '../MintScopedLock';
import { OperationIdLock } from '../OperationIdLock';
import { getMintQuoteAmount, type MintQuote } from '../../models/MintQuote';
import {
  assessMintQuoteClaimability,
  type MintQuoteClaimabilityAssessment,
} from '../../models/MintQuoteClaimability.ts';
import type { MintQuoteRef } from '../../models/QuoteIdentity';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle';

export interface ClaimMintQuoteOptions {
  autoClaimRemaining?: boolean;
}

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

  private async createInitOperation(
    mintUrl: string,
    intent: UnitAmount,
    method: MintMethod,
    methodData: MintMethodData,
    options: { quoteId: string },
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
    const releaseMintLock = await this.mintScopedLock.acquire(normalizeMintUrl(mintUrl));
    try {
      const quote = await this.resolveMintQuoteForOperationCreation(
        mintUrl,
        method,
        options.quoteId,
        parsed,
      );
      const operation = createMintOperation(
        operationId,
        quote.mintUrl,
        {
          method,
          methodData,
        } as MintMethodMeta,
        parsed,
        { quoteId: quote.quoteId },
      );

      await this.mintOperationRepository.create(operation);
      this.logger?.debug('Mint operation created', {
        operationId,
        mintUrl: operation.mintUrl,
        quoteId: operation.quoteId,
        method,
        amount: parsed.amount,
        unit: parsed.unit,
      });

      return operation;
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

    const fixedAmount = getMintQuoteAmount(quote);
    if (fixedAmount && !fixedAmount.equals(intent.amount)) {
      throw new Error(
        `Mint quote ${quote.quoteId} amount ${fixedAmount} does not match requested amount ${intent.amount}`,
      );
    }
    if (quote.unit !== intent.unit) {
      throw new Error(
        `Mint quote ${quote.quoteId} unit ${quote.unit} does not match requested unit ${intent.unit}`,
      );
    }

    if (fixedAmount) {
      const existing = await this.getOperationByQuote(quote.mintUrl, method, quote.quoteId);
      if (existing) {
        throw new Error(
          `Mint quote ${quote.quoteId} is already tracked by operation ${existing.id} in state ${existing.state}`,
        );
      }
    }

    return quote;
  }

  async prepare(quoteRef: MintQuoteRef, requestedAmount: Amount): Promise<PendingMintOperation> {
    const quote = await this.quoteLifecycle.requireMintQuoteRefForPrepare(quoteRef);
    const amount = Amount.from(requestedAmount);

    const fixedAmount = getMintQuoteAmount(quote);
    if (fixedAmount && !fixedAmount.equals(amount)) {
      throw new Error(
        `Mint quote ${quote.quoteId} amount ${fixedAmount} does not match requested amount ${amount}`,
      );
    }

    const handler = this.handlerProvider.get(quote.method);
    await handler.validateQuoteForPrepare?.(quote as any);

    const initOperation = await this.createInitOperation(
      quote.mintUrl,
      { amount, unit: quote.unit },
      quote.method,
      {} as MintMethodData,
      { quoteId: quote.quoteId },
    );

    return this.prepareInitOperation(initOperation.id);
  }

  private async prepareInitOperation(
    operationId: string,
    options?: {
      skipMintLock?: boolean;
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
        const importedQuote = await this.quoteLifecycle.loadMintQuoteSnapshotForOperation(initOp);
        const handler = this.handlerProvider.get(initOp.method);
        await this.mintService.assertMethodUnitSupported(
          initOp.mintUrl,
          4,
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
    while (true) {
      const operation = await this.mintOperationRepository.getById(operationId);
      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
      }

      if (isTerminalOperation(operation)) {
        return operation;
      }

      if (operation.state === 'executing') {
        if (this.isOperationLocked(operationId)) {
          await this.operationIdLock.waitForUnlock(operationId);
          continue;
        }

        try {
          await this.recoverExecutingOperation(operation);
        } catch (error) {
          if (!(error instanceof OperationInProgressError)) {
            throw error;
          }

          await this.operationIdLock.waitForUnlock(operationId);
        }

        const recovered = await this.mintOperationRepository.getById(operationId);
        if (recovered?.state === 'executing') {
          throw new Error(`Operation ${operationId} remains executing after recovery`);
        }
        continue;
      }

      if (operation.state !== 'pending') {
        throw new Error(
          `Cannot execute operation ${operationId}: expected state 'pending' but found '${operation.state}'`,
        );
      }

      const quote = await this.quoteLifecycle.getMintQuote(
        operation.mintUrl,
        operation.method,
        operation.quoteId,
      );
      if (quote) {
        return this.claimPendingQuoteOperation(operation as PendingMintOperation, quote);
      }

      return this.executeReadyOperation(operationId);
    }
  }

  private async executeReadyOperation(operationId: string): Promise<TerminalMintOperation> {
    const releaseLock = await this.acquireOperationLockAfterWait(operationId);
    try {
      const operation = await this.mintOperationRepository.getById(operationId);
      if (operation && isTerminalOperation(operation)) {
        return operation;
      }
      if (!operation || operation.state !== 'pending') {
        throw new Error(
          `Cannot execute operation ${operationId}: expected state 'pending' but found '${
            operation?.state ?? 'not found'
          }'`,
        );
      }
      if (!(await this.mintService.isTrustedMint(operation.mintUrl))) {
        throw new UnknownMintError(`Mint ${operation.mintUrl} is not trusted`);
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
            return await this.finalizeIssuedOperation(executing);
          case 'ALREADY_ISSUED': {
            //CODEX: Where does recovery actually happen?
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
        const staleKeysetError = asStaleKeysetError(e);
        if (staleKeysetError) {
          return await this.handleStaleKeyset(executing, staleKeysetError);
        }
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

  private async handleStaleKeyset(
    executing: ExecutingMintOperation,
    cause: StaleKeysetError,
  ): Promise<never> {
    await this.failOperation(executing, 'Mint rejected stale output keyset', {
      code: 'stale_keyset',
      retryable: true,
    });
    await this.walletService.invalidateMintSnapshot(executing.mintUrl);
    throw cause;
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
      const siblings = await this.mintOperationRepository.getByQuoteId(
        executing.mintUrl,
        executing.method,
        executing.quoteId,
      );
      const result = await handler.recoverExecuting({
        ...this.buildDeps(),
        operation: executing as any,
        wallet,
        localClaimabilityFacts: this.getLocalClaimabilityFacts(siblings, executing.id),
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

    const sorted = operations.sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) {
        return b.updatedAt - a.updatedAt;
      }
      if (a.createdAt !== b.createdAt) {
        return b.createdAt - a.createdAt;
      }
      return b.id.localeCompare(a.id);
    });

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

  async listOperationsByQuote(mintUrl: string, quoteId: string): Promise<MintOperation[]> {
    const operations = await this.mintOperationRepository.getByMintUrl(normalizeMintUrl(mintUrl));
    return operations
      .filter((operation) => operation.quoteId === quoteId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async claimMintQuote(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
    options: ClaimMintQuoteOptions = {},
  ): Promise<MintOperation[]> {
    const releaseQuoteLock = await this.mintScopedLock.acquire(
      this.quoteLockKey(mintUrl, method, quoteId),
    );
    try {
      const quote = await this.quoteLifecycle.getMintQuote(mintUrl, method, quoteId);
      if (!quote) {
        throw new Error(
          `Cannot claim mint quote ${quoteId}: quote for ${method} at ${mintUrl} was not found`,
        );
      }
      const siblings = await this.mintOperationRepository.getByQuoteId(mintUrl, method, quoteId);
      const assessment = this.assessQuoteClaimability(quote, siblings);
      const claimable = assessment.claimAmount ?? Amount.zero();
      if (assessment.status === 'complete') {
        const completed: MintOperation[] = [];
        for (const operation of siblings) {
          if (operation.state === 'pending') {
            completed.push(await this.executeReadyOperation(operation.id));
          }
        }
        return completed;
      }
      if (assessment.status !== 'claimable' || claimable.isZero()) {
        return [];
      }
      let selectedAmount = Amount.zero();
      const selected: PendingMintOperation[] = [];
      const autoClaimRemaining = options.autoClaimRemaining ?? true;

      for (const operation of siblings) {
        if (operation.state !== 'pending') {
          continue;
        }

        const nextAmount = selectedAmount.add(operation.amount);
        if (nextAmount.greaterThan(claimable)) {
          break;
        }

        selected.push(operation as PendingMintOperation);
        selectedAmount = nextAmount;
      }

      const claimed: MintOperation[] = [];
      for (const operation of selected) {
        claimed.push(await this.executeReadyOperation(operation.id));
      }

      const remaining = claimable.subtract(selectedAmount);
      if (autoClaimRemaining && !remaining.isZero()) {
        const refreshedQuote =
          (await this.quoteLifecycle.getMintQuote(mintUrl, method, quoteId)) ?? quote;
        const refreshedSiblings = await this.mintOperationRepository.getByQuoteId(
          mintUrl,
          method,
          quoteId,
        );
        const currentAssessment = this.assessQuoteClaimability(refreshedQuote, refreshedSiblings);
        if (currentAssessment.status === 'claimable' && currentAssessment.claimAmount) {
          const autoClaimAmount = remaining.lessThan(currentAssessment.claimAmount)
            ? remaining
            : currentAssessment.claimAmount;

          if (!autoClaimAmount.isZero()) {
            const autoClaim = await this.createAutoClaimOperation(refreshedQuote, autoClaimAmount);
            claimed.push(await this.executeReadyOperation(autoClaim.id));
          }
        }
      }

      return claimed;
    } finally {
      releaseQuoteLock();
    }
  }

  async claimPendingMintQuotes(options: ClaimMintQuoteOptions = {}): Promise<MintOperation[]> {
    const quotes = await this.quoteLifecycle.getPendingMintQuotes();
    const claimed: MintOperation[] = [];

    for (const quote of quotes) {
      if (!(await this.mintService.isTrustedMint(quote.mintUrl))) {
        this.logger?.debug('Skipping pending mint quote for untrusted mint', {
          mintUrl: quote.mintUrl,
          method: quote.method,
        });
        continue;
      }
      claimed.push(
        ...(await this.claimMintQuote(quote.mintUrl, quote.method, quote.quoteId, options)),
      );
    }

    return claimed;
  }

  /** @internal Used by background schedulers to assess a canonical quote with local operation facts. */
  async getMintQuoteClaimability(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
    options: { requestedAmount?: Amount; targetOperationId?: string } = {},
  ): Promise<MintQuoteClaimabilityAssessment | undefined> {
    const quote = await this.quoteLifecycle.getMintQuote(mintUrl, method, quoteId);
    if (!quote) {
      return undefined;
    }

    const siblings = await this.mintOperationRepository.getByQuoteId(mintUrl, method, quoteId);
    return this.assessQuoteClaimability(quote, siblings, options);
  }

  private async claimPendingQuoteOperation(
    operation: PendingMintOperation,
    initialQuote: MintQuote,
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
      const quote =
        (await this.quoteLifecycle.getMintQuote(
          pending.mintUrl,
          pending.method,
          pending.quoteId,
        )) ?? initialQuote;

      const siblings = await this.mintOperationRepository.getByQuoteId(
        pending.mintUrl,
        pending.method,
        pending.quoteId,
      );
      const assessment = this.assessQuoteClaimability(quote, siblings, {
        requestedAmount: pending.amount,
        targetOperationId: pending.id,
      });
      if (assessment.status === 'invalid') {
        throw new Error(`Mint quote ${pending.quoteId} has invalid claimability accounting`);
      }
      if (assessment.status === 'waiting') {
        this.logger?.info('Mint quote is not sufficiently funded for operation', {
          operationId: pending.id,
          mintUrl: pending.mintUrl,
          quoteId: pending.quoteId,
          requestedAmount: pending.amount.toString(),
          claimableAmount: assessment.claimAmount?.toString() ?? '0',
        });
        return pending;
      }

      return this.executeReadyOperation(pending.id);
    } finally {
      releaseQuoteLock();
    }
  }

  private async createAutoClaimOperation(
    quote: MintQuote,
    amount: Amount,
  ): Promise<PendingMintOperation> {
    const initOperation = await this.createInitOperation(
      quote.mintUrl,
      { amount, unit: quote.unit },
      quote.method,
      {},
      { quoteId: quote.quoteId },
    );

    return this.prepareInitOperation(initOperation.id);
  }

  private assessQuoteClaimability(
    quote: MintQuote,
    siblings: MintOperation[],
    options: { requestedAmount?: Amount; targetOperationId?: string } = {},
  ): MintQuoteClaimabilityAssessment {
    const localFacts = this.getLocalClaimabilityFacts(siblings, options.targetOperationId);

    return assessMintQuoteClaimability(quote, {
      ...localFacts,
      requestedAmount: options.requestedAmount,
    });
  }

  private getLocalClaimabilityFacts(
    siblings: MintOperation[],
    targetOperationId?: string,
  ): { finalizedAmount: Amount; reservedAmount: Amount } {
    const finalizedAmount = siblings.reduce(
      (total, operation) => (operation.state === 'finalized' ? total.add(operation.amount) : total),
      Amount.zero(),
    );
    const locallyReserved = siblings.reduce((total, operation) => {
      if (operation.state !== 'executing' || operation.id === targetOperationId) {
        return total;
      }

      return total.add(operation.amount);
    }, Amount.zero());

    return {
      finalizedAmount,
      reservedAmount: locallyReserved,
    };
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

    if (current.method === 'bolt11') {
      await this.quoteLifecycle.recordMintQuoteObservation(
        current as PendingOrLaterOperation,
        'ISSUED',
        Date.now(),
      );
    }

    const finalized: FinalizedMintOperation = {
      ...(current as PendingOrLaterOperation),
      state: 'finalized',
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
    failure?: { code?: string; retryable?: boolean },
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
        code: failure?.code,
        retryable: failure?.retryable,
        observedAt: Date.now(),
      },
    };

    await this.mintOperationRepository.update(failed);

    await this.eventBus.emit('mint-op:failed', {
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

    const observation = await handler.checkPending({
      operation: op as PendingMintOperation,
      mintAdapter: this.mintAdapter,
      logger: this.logger,
    });

    let canonicalQuote: MintQuote | undefined;
    if (observation.quoteSnapshot) {
      canonicalQuote = await this.quoteLifecycle.recordMintQuoteSnapshot(
        op.mintUrl,
        op.method,
        observation.quoteSnapshot,
      );
    }

    let result: PendingMintCheckResult;
    if (observation.validationFailure) {
      result = {
        observedRemoteStateAt: observation.observedAt,
        quoteSnapshot: observation.quoteSnapshot,
        category: 'terminal',
        terminalFailure: observation.validationFailure,
      };
    } else {
      if (!canonicalQuote) {
        throw new Error(`Pending mint observation for operation ${op.id} has no quote snapshot`);
      }
      const siblings = await this.mintOperationRepository.getByQuoteId(
        op.mintUrl,
        op.method,
        op.quoteId,
      );
      const assessment = this.assessQuoteClaimability(canonicalQuote, siblings, {
        requestedAmount: op.amount,
        targetOperationId: op.id,
      });
      result = {
        observedRemoteStateAt: observation.observedAt,
        quoteSnapshot: observation.quoteSnapshot,
        category:
          assessment.status === 'claimable'
            ? 'ready'
            : assessment.status === 'complete'
              ? 'completed'
              : assessment.status === 'invalid'
                ? 'terminal'
                : 'waiting',
        terminalFailure:
          assessment.status === 'invalid'
            ? {
                reason: `Mint quote ${op.quoteId} has invalid claimability accounting`,
                code: 'invalid_quote',
                retryable: false,
                observedAt: observation.observedAt,
              }
            : undefined,
      };
    }

    if (result.category === 'terminal' && result.terminalFailure) {
      await this.failPendingOperation(op, result.terminalFailure);
    }

    return result;
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

    await this.eventBus.emit('mint-op:failed', {
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
