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
} from './MintOperation';
import { getOutputProofSecrets, hasPendingData, isTerminalOperation } from './MintOperation';
import type { MintMethod, PendingMintCheckResult } from './MintMethodHandler';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import { generateSubId, normalizeMintUrl } from '../../utils';
import {
  OperationInProgressError,
  ProofValidationError,
  UnknownMintError,
} from '../../models/Error';
import type { MintAdapter } from '../../infra';
import type { MintHandlerProvider } from '../../infra/handlers/mint';
import { MintScopedLock } from '../MintScopedLock';
import { OperationIdLock } from '../OperationIdLock';
import type { MintQuote } from '../../models/MintQuote';
import {
  assessMintQuoteClaimability,
  type MintQuoteClaimabilityAssessment,
} from '../../models/MintQuoteClaimability.ts';
import type { MintQuoteRef } from '../../models/QuoteIdentity';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle';
import type { CoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import {
  prepareMint,
  beginMintExecution,
  applyMintResult,
  failMint,
  cleanupMintInit,
  deferMintRecovery,
} from '../../transactions/transitions/mint/MintTransitions.ts';
import type { PrepareMintResult } from '../../transactions/transitions/mint/MintTransitionTypes.ts';
import { createKeyChain } from '../../proofs/KeysetSelection.ts';
import { restoreOutputProofs } from '../../infra/ProofRestore.ts';

export interface ClaimMintQuoteOptions {
  autoClaimRemaining?: boolean;
}

/**
 * MintOperationService orchestrates mint quote redemption as a crash-safe saga.
 */
export class MintOperationService {
  private readonly operationIdLock = new OperationIdLock();
  private recoveryLock: Promise<void> | null = null;
  private readonly mintScopedLock: MintScopedLock;

  constructor(
    private readonly dependencies: {
      handlerProvider: MintHandlerProvider;
      mintOperationQueries: Pick<
        MintOperationRepository,
        'getById' | 'getByQuoteId' | 'getByMintUrl' | 'getByState' | 'getPending'
      >;
      proofQueries: Pick<ProofRepository, 'getProofBySecret'>;
      transactionRunner: CoreTransactionRunner;
      loadSeed: () => Promise<Uint8Array>;
      quoteLifecycle: Pick<
        QuoteLifecycle,
        | 'requireMintQuoteRefForPrepare'
        | 'getMintQuote'
        | 'getPendingMintQuotes'
        | 'recordMintQuoteSnapshot'
      >;
      mintService: Pick<
        MintService,
        'isTrustedMint' | 'assertMethodUnitSupported' | 'refreshAndCommitIfStale'
      >;
      walletService: Pick<WalletService, 'getWalletWithActiveKeysetId'>;
      mintAdapter: MintAdapter;
      eventBus: EventBus<CoreEvents>;
      logger?: Logger;
      mintScopedLock?: MintScopedLock;
    },
  ) {
    this.mintScopedLock = dependencies.mintScopedLock ?? new MintScopedLock();
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

  async prepare(quoteRef: MintQuoteRef, requestedAmount: Amount): Promise<PendingMintOperation> {
    const quote = await this.dependencies.quoteLifecycle.requireMintQuoteRefForPrepare(quoteRef);
    // Keep same-session coordination with legacy allocators until their transaction migrations.
    const releaseMintLock = await this.mintScopedLock.acquire(quote.mintUrl);
    let result: PrepareMintResult;
    try {
      const amount = Amount.from(requestedAmount);
      const handler = this.dependencies.handlerProvider.get(quote.method);
      await handler.validateQuoteForPrepare?.(quote as any);
      await this.dependencies.mintService.assertMethodUnitSupported(
        quote.mintUrl,
        4,
        quote.method,
        quote.method === 'onchain' ? quote.unit : { amount, unit: quote.unit },
      );
      const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(quote.mintUrl);
      const activeKeys = createKeyChain(quote.mintUrl, quote.unit, metadata.keysets)
        .getCheapestKeyset()
        .toMintKeys();
      if (!activeKeys) throw new ProofValidationError('Active keyset is missing mint keys');
      const seed = await this.dependencies.loadSeed();
      const operationId = generateSubId();
      const now = Date.now();
      result = await this.dependencies.transactionRunner.run((tx) =>
        prepareMint(tx, {
          operationId,
          mintUrl: quote.mintUrl,
          method: quote.method,
          quoteId: quote.quoteId,
          amount,
          unit: quote.unit,
          activeKeys,
          seed,
          now,
        }),
      );
    } finally {
      releaseMintLock();
    }
    if (result.changed) {
      if (result.counter) await this.publishCommittedEvent('counter:updated', result.counter);
      await this.publishCommittedEvent('mint-op:pending', {
        mintUrl: result.operation.mintUrl,
        operationId: result.operation.id,
        operation: result.operation,
      });
    }
    return result.operation;
  }

  async execute(operationId: string): Promise<MintOperation> {
    while (true) {
      const operation = await this.dependencies.mintOperationQueries.getById(operationId);
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

        const recovered = await this.dependencies.mintOperationQueries.getById(operationId);
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

      const quote = await this.dependencies.quoteLifecycle.getMintQuote(
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

  private async executeReadyOperation(operationId: string): Promise<MintOperation> {
    const releaseLock = await this.acquireOperationLockAfterWait(operationId);
    try {
      const operation = await this.dependencies.mintOperationQueries.getById(operationId);
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
      if (!(await this.dependencies.mintService.isTrustedMint(operation.mintUrl))) {
        throw new UnknownMintError(`Mint ${operation.mintUrl} is not trusted`);
      }

      const now = Date.now();
      const authorization = await this.dependencies.transactionRunner.run((tx) =>
        beginMintExecution(tx, { operationId, now }),
      );
      if (!authorization.changed || authorization.operation.state !== 'executing')
        return authorization.operation;
      const executing = authorization.operation;

      await this.publishCommittedEvent('mint-op:executing', {
        mintUrl: executing.mintUrl,
        operationId: executing.id,
        operation: executing,
      });

      try {
        const handler = this.dependencies.handlerProvider.get(executing.method);
        const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
          executing.mintUrl,
          executing.unit,
        );
        const result = await handler.execute({
          mintAdapter: this.dependencies.mintAdapter,
          logger: this.dependencies.logger,
          operation: executing as any,
          wallet,
        });

        switch (result.status) {
          case 'ISSUED':
            return await this.finalizeIssuedOperation(executing, result.proofs);
          case 'ALREADY_ISSUED':
            return await this.finalizeIssuedOperation(
              executing,
              (await this.hasSavedOutputs(executing)) ? [] : await this.restoreOutputs(executing),
            );
          case 'FAILED':
            throw new Error(result.error ?? 'Mint execution failed');
        }
      } catch (e) {
        await this.tryRecoverExecutingOperation(executing);

        const current = await this.dependencies.mintOperationQueries.getById(operationId);
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
    const operation = await this.dependencies.mintOperationQueries.getById(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    if (isTerminalOperation(operation)) {
      this.dependencies.logger?.debug('Operation already finalized', { operationId });
      return operation;
    }

    if (operation.state === 'pending') {
      return this.execute(operation.id);
    }

    if (operation.state === 'executing') {
      await this.recoverExecutingOperation(operation as ExecutingMintOperation);
      const updated = await this.dependencies.mintOperationQueries.getById(operationId);
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

      const initOps = await this.dependencies.mintOperationQueries.getByState('init');
      for (const op of initOps) {
        try {
          await this.recoverInitOperation(op as InitMintOperation);
          initCount++;
        } catch (e) {
          if (e instanceof OperationInProgressError) {
            this.dependencies.logger?.debug('Mint init operation in progress, skipping recovery', {
              operationId: op.id,
            });
            continue;
          }
          this.dependencies.logger?.warn('Failed to recover mint init operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const pendingOps = await this.dependencies.mintOperationQueries.getByState('pending');
      for (const op of pendingOps) {
        try {
          if (await this.dependencies.mintService.isTrustedMint(op.mintUrl)) {
            await this.checkPendingOperation(op.id);
            pendingCount++;
          } else {
            this.dependencies.logger?.warn(
              'Skipping recovery of pending operation for untrusted mint',
              {
                operationId: op.id,
                mintUrl: op.mintUrl,
              },
            );
          }
        } catch (e) {
          this.dependencies.logger?.warn('Failed to reconcile stale pending mint operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const executingOps = await this.dependencies.mintOperationQueries.getByState('executing');
      for (const op of executingOps) {
        try {
          await this.recoverExecutingOperation(op as ExecutingMintOperation);
          executingCount++;
        } catch (e) {
          if (e instanceof OperationInProgressError) {
            this.dependencies.logger?.debug(
              'Mint executing operation in progress, skipping recovery',
              {
                operationId: op.id,
              },
            );
            continue;
          }

          this.dependencies.logger?.error('Error recovering executing mint operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      this.dependencies.logger?.info('Mint operation recovery completed', {
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
      const current = await this.dependencies.mintOperationQueries.getById(op.id);
      if (!current) {
        this.dependencies.logger?.warn('Mint operation missing during recovery', {
          operationId: op.id,
        });
        return;
      }

      if (isTerminalOperation(current)) {
        return;
      }

      if (current.state !== 'executing') {
        this.dependencies.logger?.debug('Mint operation not executing during recovery', {
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

      if (!(await this.dependencies.mintService.isTrustedMint(executing.mintUrl))) {
        this.dependencies.logger?.warn(
          'Mint is not trusted, skipping recovery of executing mint operation',
          {
            operationId: executing.id,
            mintUrl: executing.mintUrl,
            quoteId: executing.quoteId,
          },
        );
        return;
      }

      const handler = this.dependencies.handlerProvider.get(executing.method);
      const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
        executing.mintUrl,
        executing.unit,
      );
      const siblings = await this.dependencies.mintOperationQueries.getByQuoteId(
        executing.mintUrl,
        executing.method,
        executing.quoteId,
      );
      const result = await handler.recoverExecuting({
        mintAdapter: this.dependencies.mintAdapter,
        logger: this.dependencies.logger,
        operation: executing as any,
        wallet,
        localClaimabilityFacts: this.getLocalClaimabilityFacts(siblings, executing.id),
        restoreOutputs: () => this.restoreOutputs(executing),
        recordQuoteSnapshot: async (snapshot) => {
          await this.dependencies.quoteLifecycle.recordMintQuoteSnapshot(
            executing.mintUrl,
            executing.method,
            snapshot,
          );
        },
      });

      switch (result.status) {
        case 'ISSUED': {
          await this.finalizeIssuedOperation(executing, result.proofs);
          break;
        }
        case 'UNRESOLVED':
          await this.deferRecovery(executing, result.error);
          break;
        case 'REJECTED':
          await this.failOperation(executing, result.error);
          break;
      }
    } finally {
      if (releaseLock) {
        releaseLock();
      }
    }
  }

  async getOperation(operationId: string): Promise<MintOperation | null> {
    return this.dependencies.mintOperationQueries.getById(operationId);
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
    return this.dependencies.mintOperationQueries.getByQuoteId(mintUrl, method, quoteId);
  }

  async listOperationsByQuote(mintUrl: string, quoteId: string): Promise<MintOperation[]> {
    const operations = await this.dependencies.mintOperationQueries.getByMintUrl(
      normalizeMintUrl(mintUrl),
    );
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
      const quote = await this.dependencies.quoteLifecycle.getMintQuote(mintUrl, method, quoteId);
      if (!quote) {
        throw new Error(
          `Cannot claim mint quote ${quoteId}: quote for ${method} at ${mintUrl} was not found`,
        );
      }
      const siblings = await this.dependencies.mintOperationQueries.getByQuoteId(
        mintUrl,
        method,
        quoteId,
      );
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
          (await this.dependencies.quoteLifecycle.getMintQuote(mintUrl, method, quoteId)) ?? quote;
        const refreshedSiblings = await this.dependencies.mintOperationQueries.getByQuoteId(
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
    const quotes = await this.dependencies.quoteLifecycle.getPendingMintQuotes();
    const claimed: MintOperation[] = [];

    for (const quote of quotes) {
      if (!(await this.dependencies.mintService.isTrustedMint(quote.mintUrl))) {
        this.dependencies.logger?.debug('Skipping pending mint quote for untrusted mint', {
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
    const quote = await this.dependencies.quoteLifecycle.getMintQuote(mintUrl, method, quoteId);
    if (!quote) {
      return undefined;
    }

    const siblings = await this.dependencies.mintOperationQueries.getByQuoteId(
      mintUrl,
      method,
      quoteId,
    );
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
      const current = await this.dependencies.mintOperationQueries.getById(operation.id);
      if (!current || current.state !== 'pending') {
        if (current) return current;
        throw new Error(`Operation ${operation.id} not found`);
      }

      const pending = current as PendingMintOperation;
      const quote =
        (await this.dependencies.quoteLifecycle.getMintQuote(
          pending.mintUrl,
          pending.method,
          pending.quoteId,
        )) ?? initialQuote;

      const siblings = await this.dependencies.mintOperationQueries.getByQuoteId(
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
        this.dependencies.logger?.info('Mint quote is not sufficiently funded for operation', {
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
    return this.prepare(
      { mintUrl: quote.mintUrl, method: quote.method, quoteId: quote.quoteId },
      amount,
    );
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
    return this.dependencies.mintOperationQueries.getPending();
  }

  private async recoverInitOperation(op: InitMintOperation): Promise<void> {
    const releaseLock = await this.acquireOperationLock(op.id);
    try {
      await this.dependencies.transactionRunner.run((tx) => cleanupMintInit(tx, op.id));
    } finally {
      releaseLock();
    }
  }

  async getPendingOperations(): Promise<PendingMintOperation[]> {
    const ops = await this.dependencies.mintOperationQueries.getByState('pending');
    return ops.filter((op): op is PendingMintOperation => op.state === 'pending');
  }

  private async tryRecoverExecutingOperation(op: ExecutingMintOperation): Promise<void> {
    try {
      await this.recoverExecutingOperation(op, { skipLock: true });
      this.dependencies.logger?.info('Recovered executing mint operation after failure', {
        operationId: op.id,
      });
    } catch (recoveryError) {
      this.dependencies.logger?.warn(
        'Failed to recover executing mint operation, will retry on startup',
        {
          operationId: op.id,
          error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
        },
      );
    }
  }

  private async restoreOutputs(op: ExecutingMintOperation): Promise<Proof[]> {
    const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(op.mintUrl);
    const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
      op.mintUrl,
      op.unit,
    );
    return restoreOutputProofs(wallet, metadata.keysets, op.unit, op.outputData);
  }

  private async finalizeIssuedOperation(
    op: ExecutingMintOperation,
    proofs: Proof[] = [],
  ): Promise<FinalizedMintOperation> {
    const now = Date.now();
    const result = await this.dependencies.transactionRunner.run((tx) =>
      applyMintResult(tx, { operation: op, proofs, now }),
    );
    if (result.changed) {
      for (const keysetId of new Set(result.proofs.map((proof) => proof.id))) {
        await this.publishCommittedEvent('proofs:saved', {
          mintUrl: op.mintUrl,
          keysetId,
          proofs: result.proofs.filter((proof) => proof.id === keysetId),
        });
      }
      await this.publishCommittedEvent('mint-op:finalized', {
        mintUrl: op.mintUrl,
        operationId: op.id,
        operation: result.operation,
      });
    }
    return result.operation;
  }

  private async failOperation(op: ExecutingMintOperation, error: string): Promise<void> {
    const now = Date.now();
    const result = await this.dependencies.transactionRunner.run((tx) =>
      failMint(tx, {
        operationId: op.id,
        expectedState: 'executing',
        failure: { reason: error, observedAt: now },
        now,
      }),
    );
    if (result.changed && result.operation.state === 'failed')
      await this.publishCommittedEvent('mint-op:failed', {
        mintUrl: op.mintUrl,
        operationId: op.id,
        operation: result.operation,
      });
  }

  private async deferRecovery(op: ExecutingMintOperation, error?: string): Promise<void> {
    const now = Date.now();
    await this.dependencies.transactionRunner.run((tx) =>
      deferMintRecovery(tx, { operation: op, error, now }),
    );
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
    const handler = this.dependencies.handlerProvider.get(op.method);

    const observation = await handler.checkPending({
      operation: op as PendingMintOperation,
      mintAdapter: this.dependencies.mintAdapter,
      logger: this.dependencies.logger,
    });

    let canonicalQuote: MintQuote | undefined;
    if (observation.quoteSnapshot) {
      canonicalQuote = await this.dependencies.quoteLifecycle.recordMintQuoteSnapshot(
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
      const siblings = await this.dependencies.mintOperationQueries.getByQuoteId(
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
  ): Promise<FailedMintOperation | FinalizedMintOperation> {
    if (!terminalFailure) {
      throw new Error(`Cannot fail pending operation ${op.id} without terminal failure details`);
    }

    const now = Date.now();
    const result = await this.dependencies.transactionRunner.run((tx) =>
      failMint(tx, { operationId: op.id, expectedState: 'pending', failure: terminalFailure, now }),
    );
    if (result.changed && result.operation.state === 'failed')
      await this.publishCommittedEvent('mint-op:failed', {
        mintUrl: op.mintUrl,
        operationId: op.id,
        operation: result.operation,
      });
    return result.operation;
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
      const proof = await this.dependencies.proofQueries.getProofBySecret(op.mintUrl, secret);
      if (!proof) {
        return false;
      }
    }

    return true;
  }
  private async publishCommittedEvent<E extends keyof CoreEvents>(
    event: E,
    payload: CoreEvents[E],
  ): Promise<void> {
    try {
      await this.dependencies.eventBus.emit(event, payload, { throwOnError: true });
    } catch (error) {
      this.dependencies.logger?.warn('Mint event listener failed after commit', { event, error });
    }
  }
}
