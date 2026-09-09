import type { MintQueries } from '../../mints/MintMetadata.ts';
import type { MintService } from '../../services/MintService.ts';
import { Amount, type Proof } from '@cashu/cashu-ts';
import type { MintCommit, MintQuoteCommit, SettleMintInput } from './MintCommands.ts';
import { mintLocalClaimabilityFacts } from './MintLocalClaimability.ts';
import type { MintRemote } from './MintRemote.ts';
import type {
  MintOperationQueries,
  MintProofQueries,
  MintQuoteQueries,
} from '../../queries/MintOperationQueries.ts';
import type { MintTransactions } from '../../transactions/mint/MintTransactions.ts';
import {
  mintQuoteObservationFromBolt11Response,
  mintQuoteObservationFromBolt12Response,
  mintQuoteObservationFromOnchainResponse,
} from '../../models/MintQuoteObservationFactory.ts';
import type {
  ExecutingMintOperation,
  FailedMintOperation,
  InitMintOperation,
  MintOperation,
  PendingMintOperation,
  PendingOrLaterOperation,
} from './MintOperation';
import {
  createMintOperation,
  getOutputProofSecrets,
  hasPendingData,
  isTerminalOperation,
} from './MintOperation';
import type {
  MintMethod,
  PendingMintCheckResult,
  MintMethodQuoteSnapshot,
} from './MintMethodHandler';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import { generateSubId, normalizeMintUrl } from '../../utils';
import {
  OperationInProgressError,
  ProofValidationError,
  UnknownMintError,
} from '../../models/Error';
import { MintScopedLock } from '../MintScopedLock';
import { OperationIdLock } from '../OperationIdLock';
import { getMintQuoteAmount, type MintQuote } from '../../models/MintQuote';
import {
  assessMintQuoteClaimability,
  type MintQuoteClaimabilityAssessment,
} from '../../models/MintQuoteClaimability.ts';
import type { MintQuoteRef } from '../../models/QuoteIdentity';

export interface ClaimMintQuoteOptions {
  autoClaimRemaining?: boolean;
}

export interface MintOperationDependencies {
  mintQueries: Pick<MintQueries, 'isTrustedMint'>;
  mintMetadataRefresh: Pick<MintService, 'refreshAndCommitIfStale'>;
  loadSeed(): Promise<Uint8Array>;
  operations: MintOperationQueries;
  proofs: MintProofQueries;
  quotes: MintQuoteQueries;
  remote: MintRemote;
  transactions: MintTransactions;
  events: Pick<EventBus<CoreEvents>, 'emit'>;
  logger?: Logger;
  mintScopedLock?: MintScopedLock;
}

/** Coordinates the existing method-specific saga through committed Mint commands. */
export class MintOperationService {
  private readonly operationIdLock = new OperationIdLock();
  private recoveryLock: Promise<void> | null = null;
  private readonly mintScopedLock: MintScopedLock;

  constructor(private readonly deps: MintOperationDependencies) {
    this.mintScopedLock = deps.mintScopedLock ?? new MintScopedLock();
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
    const quote = await this.deps.quotes.requireMintQuoteRefForPrepare(quoteRef);
    const amount = Amount.from(requestedAmount);
    if (amount.isZero()) throw new ProofValidationError('Amount must be a positive number');
    if (!(await this.deps.mintQueries.isTrustedMint(quote.mintUrl)))
      throw new UnknownMintError(`Mint ${quote.mintUrl} is not trusted`);
    const fixedAmount = getMintQuoteAmount(quote);
    if (fixedAmount && !fixedAmount.equals(amount)) {
      throw new Error(
        `Mint quote ${quote.quoteId} amount ${fixedAmount} does not match requested amount ${amount}`,
      );
    }
    const releaseMintLock = await this.mintScopedLock.acquire(quote.mintUrl);
    try {
      if (fixedAmount) {
        const existing = await this.getOperationByQuote(quote.mintUrl, quote.method, quote.quoteId);
        if (existing)
          throw new Error(
            `Mint quote ${quote.quoteId} is already tracked by operation ${existing.id} in state ${existing.state}`,
          );
      }
      const operation = createMintOperation(
        generateSubId(),
        quote.mintUrl,
        { method: quote.method, methodData: {} },
        { amount, unit: quote.unit },
        { quoteId: quote.quoteId },
      );
      const metadata = await this.deps.mintMetadataRefresh.refreshAndCommitIfStale(quote.mintUrl);
      const seed = await this.deps.loadSeed();
      const input = await this.deps.remote.prepare(operation, quote, metadata, seed);
      const prepared = await this.deps.transactions.prepare(input);
      await this.emit('counter:updated', prepared.counter);
      await this.publish({ operation: prepared.operation, changed: true, proofs: [] });
      return prepared.operation;
    } finally {
      releaseMintLock();
    }
  }

  async execute(operationId: string): Promise<MintOperation> {
    while (true) {
      const operation = await this.deps.operations.getById(operationId);
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

        const recovered = await this.deps.operations.getById(operationId);
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

      const quote = await this.deps.quotes.getMintQuote(
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
      const operation = await this.deps.operations.getById(operationId);
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
      if (!(await this.deps.mintQueries.isTrustedMint(operation.mintUrl))) {
        throw new UnknownMintError(`Mint ${operation.mintUrl} is not trusted`);
      }

      const metadata = await this.deps.mintMetadataRefresh.refreshAndCommitIfStale(
        operation.mintUrl,
      );
      const authorized = await this.deps.transactions.authorize({
        operationId,
        timestamp: Date.now(),
      });
      await this.publish(authorized);
      if (!authorized.changed || authorized.operation.state !== 'executing')
        return authorized.operation;
      const executing = authorized.operation;

      try {
        const result = await this.deps.remote.execute(executing, metadata);

        switch (result.status) {
          case 'ISSUED': {
            const resultCommit = await this.settleIssuedOperation(
              executing,
              result.proofs,
              'issued',
            );
            if (resultCommit.state === 'executing')
              throw new Error(`Failed to persist output proofs for operation ${executing.id}`);
            return resultCommit;
          }
          case 'ALREADY_ISSUED':
            return await this.settleIssuedOperation(executing, [], 'already-issued');
          case 'FAILED':
            throw new Error(result.error ?? 'Mint execution failed');
        }
      } catch (e) {
        await this.tryRecoverExecutingOperation(executing);

        const current = await this.deps.operations.getById(operationId);
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
    const operation = await this.deps.operations.getById(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    if (isTerminalOperation(operation)) {
      this.deps.logger?.debug('Operation already finalized', { operationId });
      return operation;
    }

    if (operation.state === 'pending') {
      return this.execute(operation.id);
    }

    if (operation.state === 'executing') {
      await this.recoverExecutingOperation(operation as ExecutingMintOperation);
      const updated = await this.deps.operations.getById(operationId);
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

      const initOps = await this.deps.operations.getByState('init');
      for (const op of initOps) {
        try {
          await this.recoverInitOperation(op as InitMintOperation);
          initCount++;
        } catch (e) {
          if (e instanceof OperationInProgressError) {
            this.deps.logger?.debug('Mint init operation in progress, skipping recovery', {
              operationId: op.id,
            });
            continue;
          }
          this.deps.logger?.warn('Failed to recover mint init operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const pendingOps = await this.deps.operations.getByState('pending');
      for (const op of pendingOps) {
        try {
          if (await this.deps.mintQueries.isTrustedMint(op.mintUrl)) {
            await this.checkPendingOperation(op.id);
            pendingCount++;
          } else {
            this.deps.logger?.warn('Skipping recovery of pending operation for untrusted mint', {
              operationId: op.id,
              mintUrl: op.mintUrl,
            });
          }
        } catch (e) {
          this.deps.logger?.warn('Failed to reconcile stale pending mint operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const executingOps = await this.deps.operations.getByState('executing');
      for (const op of executingOps) {
        try {
          await this.recoverExecutingOperation(op as ExecutingMintOperation);
          executingCount++;
        } catch (e) {
          if (e instanceof OperationInProgressError) {
            this.deps.logger?.debug('Mint executing operation in progress, skipping recovery', {
              operationId: op.id,
            });
            continue;
          }

          this.deps.logger?.error('Error recovering executing mint operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      this.deps.logger?.info('Mint operation recovery completed', {
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
      const current = await this.deps.operations.getById(op.id);
      if (!current) {
        this.deps.logger?.warn('Mint operation missing during recovery', { operationId: op.id });
        return;
      }

      if (isTerminalOperation(current)) {
        return;
      }

      if (current.state !== 'executing') {
        this.deps.logger?.debug('Mint operation not executing during recovery', {
          operationId: current.id,
          state: current.state,
        });
        return;
      }

      const executing = current as ExecutingMintOperation;

      if (await this.hasSavedOutputs(executing)) {
        await this.settleIssuedOperation(executing, [], 'recovered');
        return;
      }

      if (!(await this.deps.mintQueries.isTrustedMint(executing.mintUrl))) {
        this.deps.logger?.warn(
          'Mint is not trusted, skipping recovery of executing mint operation',
          {
            operationId: executing.id,
            mintUrl: executing.mintUrl,
            quoteId: executing.quoteId,
          },
        );
        return;
      }

      const siblings = await this.deps.operations.getByQuoteId(
        executing.mintUrl,
        executing.method,
        executing.quoteId,
      );
      const metadata = await this.deps.mintMetadataRefresh.refreshAndCommitIfStale(
        executing.mintUrl,
      );
      const result = await this.deps.remote.recoverExecuting(
        executing,
        mintLocalClaimabilityFacts(siblings, executing.id),
        metadata,
      );

      switch (result.status) {
        case 'FINALIZED': {
          await this.settleIssuedOperation(executing, result.proofs, 'recovered');
          break;
        }
        case 'PENDING': {
          await this.transitionToPending(executing, result.error);
          this.deps.logger?.warn('Mint operation returned to pending after recovery', {
            operationId: executing.id,
            mintUrl: executing.mintUrl,
            quoteId: executing.quoteId,
            error: result.error,
          });
          break;
        }
        case 'TERMINAL': {
          await this.failOperation(executing, result.error);
          this.deps.logger?.warn('Mint operation moved to failed during recovery', {
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
    return this.deps.operations.getById(operationId);
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
    return this.deps.operations.getByQuoteId(mintUrl, method, quoteId);
  }

  async listOperationsByQuote(mintUrl: string, quoteId: string): Promise<MintOperation[]> {
    const operations = await this.deps.operations.getByMintUrl(normalizeMintUrl(mintUrl));
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
      const quote = await this.deps.quotes.getMintQuote(mintUrl, method, quoteId);
      if (!quote) {
        throw new Error(
          `Cannot claim mint quote ${quoteId}: quote for ${method} at ${mintUrl} was not found`,
        );
      }
      const siblings = await this.deps.operations.getByQuoteId(mintUrl, method, quoteId);
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
          (await this.deps.quotes.getMintQuote(mintUrl, method, quoteId)) ?? quote;
        const refreshedSiblings = await this.deps.operations.getByQuoteId(mintUrl, method, quoteId);
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
    const quotes = await this.deps.quotes.getPendingMintQuotes();
    const claimed: MintOperation[] = [];

    for (const quote of quotes) {
      if (!(await this.deps.mintQueries.isTrustedMint(quote.mintUrl))) {
        this.deps.logger?.debug('Skipping pending mint quote for untrusted mint', {
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
    const quote = await this.deps.quotes.getMintQuote(mintUrl, method, quoteId);
    if (!quote) {
      return undefined;
    }

    const siblings = await this.deps.operations.getByQuoteId(mintUrl, method, quoteId);
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
      const current = await this.deps.operations.getById(operation.id);
      if (!current || current.state !== 'pending') {
        if (current) return current;
        throw new Error(`Operation ${operation.id} not found`);
      }

      const pending = current as PendingMintOperation;
      const quote =
        (await this.deps.quotes.getMintQuote(pending.mintUrl, pending.method, pending.quoteId)) ??
        initialQuote;

      const siblings = await this.deps.operations.getByQuoteId(
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
        this.deps.logger?.info('Mint quote is not sufficiently funded for operation', {
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
    return this.prepare(quote, amount);
  }

  private assessQuoteClaimability(
    quote: MintQuote,
    siblings: MintOperation[],
    options: { requestedAmount?: Amount; targetOperationId?: string } = {},
  ): MintQuoteClaimabilityAssessment {
    const localFacts = mintLocalClaimabilityFacts(siblings, options.targetOperationId);

    return assessMintQuoteClaimability(quote, {
      ...localFacts,
      requestedAmount: options.requestedAmount,
    });
  }

  private quoteLockKey(mintUrl: string, method: MintMethod, quoteId: string): string {
    return `${mintUrl}::${method}::${quoteId}`;
  }

  async getInFlightOperations(): Promise<MintOperation[]> {
    return this.deps.operations.getPending();
  }

  private async recoverInitOperation(op: InitMintOperation): Promise<void> {
    const releaseLock = await this.acquireOperationLock(op.id);
    try {
      const current = await this.deps.operations.getById(op.id);
      if (!current || current.state !== 'init') {
        return;
      }

      await this.deps.transactions.deleteInit(op.id);
      this.deps.logger?.info('Cleaned up failed mint init operation', { operationId: op.id });
    } finally {
      releaseLock();
    }
  }

  async getPendingOperations(): Promise<PendingMintOperation[]> {
    const ops = await this.deps.operations.getByState('pending');
    return ops.filter((op): op is PendingMintOperation => op.state === 'pending');
  }

  private async tryRecoverExecutingOperation(op: ExecutingMintOperation): Promise<void> {
    try {
      await this.recoverExecutingOperation(op, { skipLock: true });
      this.deps.logger?.info('Recovered executing mint operation after failure', {
        operationId: op.id,
      });
    } catch (recoveryError) {
      this.deps.logger?.warn('Failed to recover executing mint operation, will retry on startup', {
        operationId: op.id,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
    }
  }

  private async settleIssuedOperation(
    operation: ExecutingMintOperation,
    candidates: Proof[],
    outcome: SettleMintInput['outcome'],
  ): Promise<MintOperation> {
    let proofs = candidates;
    if (!(await this.hasSavedOutputs(operation))) {
      const secrets = new Set(candidates.map((proof) => proof.secret));
      if (!getOutputProofSecrets(operation).every((secret) => secrets.has(secret))) {
        const metadata = await this.deps.mintMetadataRefresh.refreshAndCommitIfStale(
          operation.mintUrl,
        );
        proofs = [...proofs, ...(await this.deps.remote.restoreOutputs(operation, metadata))];
      }
    }
    const committed = await this.deps.transactions.settle({
      operation,
      proofs,
      outcome,
      timestamp: Date.now(),
    });
    await this.publish(committed);
    return committed.operation;
  }

  private async failOperation(operation: ExecutingMintOperation, error: string) {
    const timestamp = Date.now();
    const committed = await this.deps.transactions.fail({
      operation,
      failure: { reason: error, observedAt: timestamp },
      timestamp,
    });
    await this.publish(committed);
    return committed.operation;
  }

  private async transitionToPending(operation: ExecutingMintOperation, error?: string) {
    const committed = await this.deps.transactions.returnToPending({
      operation,
      error,
      timestamp: Date.now(),
    });
    await this.publish(committed);
    return committed.operation;
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
    const observation = await this.deps.remote.observePending(op);

    let canonicalQuote: MintQuote | undefined;
    if (observation.quoteSnapshot) {
      const snapshot = observation.quoteSnapshot;
      const incoming =
        op.method === 'bolt11'
          ? mintQuoteObservationFromBolt11Response(
              op.mintUrl,
              snapshot as MintMethodQuoteSnapshot<'bolt11'>,
            )
          : op.method === 'bolt12'
            ? mintQuoteObservationFromBolt12Response(
                op.mintUrl,
                snapshot as MintMethodQuoteSnapshot<'bolt12'>,
              )
            : mintQuoteObservationFromOnchainResponse(
                op.mintUrl,
                snapshot as MintMethodQuoteSnapshot<'onchain'>,
              );
      const committed = await this.deps.transactions.observeQuote(incoming);
      canonicalQuote = committed.quote;
      await this.publishQuote(committed);
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
      const siblings = await this.deps.operations.getByQuoteId(op.mintUrl, op.method, op.quoteId);
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
  ): Promise<MintOperation> {
    if (!terminalFailure) {
      throw new Error(`Cannot fail pending operation ${op.id} without terminal failure details`);
    }

    const committed = await this.deps.transactions.fail({
      operation: op,
      failure: terminalFailure,
      timestamp: Date.now(),
    });
    await this.publish(committed);
    return committed.operation;
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
      const proof = await this.deps.proofs.getProofBySecret(op.mintUrl, secret);
      if (!proof) {
        return false;
      }
    }

    return true;
  }

  private async emit<E extends keyof CoreEvents>(event: E, payload: CoreEvents[E]) {
    try {
      await this.deps.events.emit(event, payload);
    } catch (error) {
      this.deps.logger?.warn('Mint event listener failed after commit', { event, error });
    }
  }

  private async publishQuote(commit: MintQuoteCommit) {
    if (!commit.changed) return;
    const { quote } = commit;
    await this.emit('mint-quote:updated', {
      mintUrl: quote.mintUrl,
      method: quote.method,
      quoteId: quote.quoteId,
      quote,
    });
  }

  private async publish(commit: MintCommit) {
    const { operation, proofs } = commit;
    for (const keysetId of new Set(proofs.map((proof) => proof.id)))
      await this.emit('proofs:saved', {
        mintUrl: operation.mintUrl,
        keysetId,
        proofs: proofs.filter((proof) => proof.id === keysetId),
      });
    if (commit.quote) await this.publishQuote(commit.quote);
    if (!commit.changed || operation.state === 'init') return;
    const payload = { mintUrl: operation.mintUrl, operationId: operation.id };
    switch (operation.state) {
      case 'pending':
        await this.emit('mint-op:pending', { ...payload, operation });
        break;
      case 'executing':
        await this.emit('mint-op:executing', { ...payload, operation });
        break;
      case 'finalized':
        await this.emit('mint-op:finalized', { ...payload, operation });
        break;
      case 'failed':
        await this.emit('mint-op:failed', { ...payload, operation });
        break;
    }
  }
}
