import {
  Amount,
  OutputData,
  sumProofs,
  type AmountLike,
  type Proof,
  type Wallet,
} from '@cashu/cashu-ts';

import type { Logger } from '../../logging/Logger.ts';
import type { MeltQuote } from '../../models/MeltQuote.ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import type { OperationEventOutboxRecord } from '../../models/OperationEventOutbox.ts';
import { evaluateMintSwapDispatchWindow } from '../../models/MintSwapPolicy.ts';
import type { Repositories, RepositoryTransactionScope } from '../../repositories/index.ts';
import type { KeyRingService } from '../../services/KeyRingService.ts';
import type { MintService } from '../../services/MintService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import { deserializeOutputData, generateSubId, normalizeMintUrl } from '../../utils.ts';
import { MintScopedLock } from '../MintScopedLock.ts';
import { OperationIdLock } from '../OperationIdLock.ts';
import type { MeltOperationService } from '../melt/MeltOperationService.ts';
import type {
  ExecutingMeltOperation,
  FinalizedMeltOperation,
  PreparedMeltOperation,
} from '../melt/MeltOperation.ts';
import type { MintOperationService } from '../mint/MintOperationService.ts';
import type { ExecutingMintOperation, FinalizedMintOperation } from '../mint/MintOperation.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import {
  createMintSwapPreparedPlanFingerprint,
  isTerminalMintSwapState,
  validateMintSwapAccounting,
  type MintSwapEventType,
  type MintSwapOperation,
  type MintSwapOperationState,
  type MintSwapPreparedPlan,
  type MintSwapSettlement,
} from './MintSwapOperation.ts';

export interface PrepareMintSwapInput {
  /** Trusted mint whose proofs will fund the Lightning payment. */
  sourceMintUrl: string;
  /** Trusted mint that will issue the exact destination amount. */
  destinationMintUrl: string;
  /** Exact amount to receive at the destination, not a source-spend budget. */
  amount: AmountLike;
  /** Mint swaps are sat-only in the current protocol contract. */
  unit?: 'sat';
  /** Minimum time that must remain before the earliest quote expiry at dispatch. */
  requiredDispatchWindowSeconds?: number;
}

export interface ListMintSwapInput {
  /** Return only operations currently in this parent state. */
  state?: MintSwapOperationState;
  /** Return operations where the normalized URL is either the source or destination mint. */
  mintUrl?: string;
}

/**
 * Preparation failed after a durable parent id had been allocated.
 *
 * The original cause is deliberately not exposed because protocol errors can contain invoices,
 * quote ids, proofs, or other sensitive material. Use `operationId` to inspect the sanitized,
 * durable failure record.
 */
export class MintSwapPreparationError extends Error {
  readonly operationId: string;

  constructor(operationId: string, cause: unknown) {
    super(`Mint swap ${operationId} could not be prepared`, {
      cause: new Error('Mint swap preparation failed; inspect durable operation state'),
    });
    this.name = 'MintSwapPreparationError';
    this.operationId = operationId;
  }
}

/** Signals canonical values that cannot satisfy the persisted mint-swap accounting contract. */
class MintSwapAccountingContradictionError extends Error {}

/**
 * Coordinates an exact-receive cross-mint swap as one durable parent operation.
 *
 * The service owns parent state, accounting, child ownership, and authorization ordering. The
 * existing mint and melt operation services continue to own their protocol-specific behavior.
 * Remote calls are intentionally made only after an authorization transaction commits, and their
 * results are applied in a later transaction; no repository transaction spans network I/O.
 */
export class MintSwapOperationService {
  private readonly operationLock = new OperationIdLock();

  constructor(
    private readonly repositories: Repositories,
    private readonly quoteLifecycle: QuoteLifecycle,
    private readonly mintOperationService: MintOperationService,
    private readonly meltOperationService: MeltOperationService,
    private readonly mintService: MintService,
    private readonly walletService: WalletService,
    private readonly keyRingService: KeyRingService,
    private readonly mintScopedLock: MintScopedLock,
    private readonly logger?: Logger,
  ) {}

  isOperationLocked(operationId: string): boolean {
    return this.operationLock.isLocked(operationId);
  }

  /**
   * Builds and reserves an immutable exact-receive plan without sending the source payment.
   *
   * Preparation persists the NUT-20 destination key before quote creation, prepares deterministic
   * destination outputs, creates the source melt quote from that locked invoice, reserves the
   * source proof plan, and finally publishes the caller-reviewable debit bounds.
   *
   * @throws {MintSwapPreparationError} after a durable parent has been created but preparation
   * cannot reach `prepared`. The error exposes the parent id for safe inspection.
   */
  async prepare(input: PrepareMintSwapInput): Promise<MintSwapOperation> {
    const sourceMintUrl = normalizeMintUrl(input.sourceMintUrl);
    const destinationMintUrl = normalizeMintUrl(input.destinationMintUrl);
    const amount = Amount.from(input.amount);
    if ((input.unit ?? 'sat') !== 'sat') throw new Error('Mint swaps support only sat');
    if (amount.isZero()) throw new Error('Mint swap destination amount must be positive');
    if (sourceMintUrl === destinationMintUrl) {
      throw new Error('Mint swap source and destination mints must be distinct');
    }

    await this.assertPreflight(sourceMintUrl, destinationMintUrl, amount);
    const sourceSupportsNut08 = await this.mintService.supportsNut(sourceMintUrl, 8);
    const operationId = generateSubId();
    const now = Date.now();
    const initial: MintSwapOperation = {
      id: operationId,
      state: 'preparing',
      revision: 0,
      sourceMintUrl,
      destinationMintUrl,
      unit: 'sat',
      destinationAmount: amount,
      retry: { attemptCount: 0 },
      createdAt: now,
      updatedAt: now,
    };
    await this.repositories.mintSwapOperationRepository.create(initial);

    try {
      // Persist recovery-critical NUT-20 key material before creating the remote locked quote.
      const keyPair = await this.keyRingService.generateMintQuoteKeyPair();
      if (keyPair.derivationIndex === undefined) {
        throw new Error('Mint swap NUT-20 key is missing its derivation index');
      }
      await this.mutate(operationId, (current) => ({
        ...current,
        destinationNut20Key: {
          publicKey: keyPair.publicKeyHex,
          derivationIndex: keyPair.derivationIndex!,
        },
      }));

      const destinationQuote = await this.quoteLifecycle.createMintQuote(
        destinationMintUrl,
        'bolt11',
        { amount: { amount, unit: 'sat' }, pubkey: keyPair.publicKeyHex },
      );
      this.assertDestinationQuote(destinationQuote, amount, keyPair.publicKeyHex);
      await this.mutate(operationId, (current) => ({
        ...current,
        destinationQuoteRef: this.quoteRef(destinationQuote),
      }));

      // Destination outputs are prepared before the invoice is paid so retries reuse one plan.
      const destinationWallet = await this.getWallet(destinationMintUrl);
      const destinationChildId = generateSubId();
      await this.withMintLock(destinationMintUrl, async () => {
        await this.repositories.withTransaction(async (scope) => {
          const child = await this.mintOperationService.prepareOwnedInTransaction({
            operationId: destinationChildId,
            parentSwapOperationId: operationId,
            quote: destinationQuote,
            amount,
            wallet: destinationWallet,
            repositories: scope,
          });
          await this.casInScope(scope, operationId, (current) => ({
            ...current,
            destinationMintOperationId: child.id,
          }));
        });
      });

      // The source pays the exact invoice created by the destination; it never invents an amount.
      const sourceQuote = await this.quoteLifecycle.createMeltQuote(
        sourceMintUrl,
        'bolt11',
        { invoice: destinationQuote.request },
        'sat',
      );
      this.assertSourceQuote(sourceQuote, amount);
      await this.mutate(operationId, (current) => ({
        ...current,
        sourceQuoteRef: this.quoteRef(sourceQuote),
      }));

      const sourceWallet = await this.getWallet(sourceMintUrl);
      const sourceChildId = generateSubId();
      await this.withMintLock(sourceMintUrl, async () => {
        await this.repositories.withTransaction(async (scope) => {
          const sourceChild = await this.meltOperationService.prepareOwnedInTransaction({
            operationId: sourceChildId,
            parentSwapOperationId: operationId,
            quote: sourceQuote,
            wallet: sourceWallet,
            repositories: scope,
          });
          const destinationChild = await scope.mintOperationRepository.getById(destinationChildId);
          if (!destinationChild || destinationChild.state !== 'pending') {
            throw new Error('Prepared destination child is missing');
          }
          // Linking both children and the immutable preview is one local transaction boundary.
          const plan = await this.buildPreparedPlan(
            sourceChild,
            destinationChild.outputData,
            destinationQuote,
            sourceQuote,
            sourceWallet,
            sourceSupportsNut08,
            input.requiredDispatchWindowSeconds,
            scope,
          );
          await this.casInScope(
            scope,
            operationId,
            (current) => ({
              ...current,
              state: 'prepared',
              sourceMeltOperationId: sourceChild.id,
              preparedPlan: plan,
            }),
            'mint-swap-op:prepared',
          );
        });
      });

      return this.requireOperation(operationId);
    } catch (cause) {
      await this.failPreparation(operationId);
      throw new MintSwapPreparationError(operationId, cause);
    }
  }

  /**
   * Authorizes and dispatches the source payment for a prepared operation.
   *
   * Trust, capabilities, and the dispatch window are rechecked immediately before authorization.
   * Calling this method for a state other than `prepared` is idempotent and returns the current
   * durable operation.
   */
  async execute(operationId: string): Promise<MintSwapOperation> {
    return this.withOperationLock(operationId, async () => {
      const operation = await this.requireOperation(operationId);
      if (operation.state !== 'prepared') return operation;
      await this.assertPreflight(
        operation.sourceMintUrl,
        operation.destinationMintUrl,
        operation.destinationAmount,
      );
      this.assertDispatchWindow(operation);

      // Commit both child and parent authorization before the irreversible remote melt call.
      let executingChild!: ExecutingMeltOperation;
      await this.repositories.withTransaction(async (scope) => {
        executingChild = await this.meltOperationService.authorizeOwnedExecutionInTransaction(
          operation.sourceMeltOperationId!,
          operation.id,
          scope,
        );
        await this.casInScope(
          scope,
          operation.id,
          (current) => ({
            ...current,
            state: 'source_inflight',
            sourceDispatchAuthorizedAt: Date.now(),
          }),
          'mint-swap-op:source-inflight',
        );
      });

      // Network I/O is outside the transaction. Recovery can now prove this call was authorized.
      const result = await this.meltOperationService.executeOwnedRemote(
        executingChild,
        operation.id,
      );
      try {
        await this.repositories.withTransaction(async (scope) => {
          const child = await this.meltOperationService.applyOwnedExecutionInTransaction(
            executingChild,
            operation.id,
            result,
            scope,
          );
          if (child.state === 'finalized') {
            await this.advanceSourceFundedInScope(scope, operation.id, child);
          }
        });
      } catch (error) {
        if (!(error instanceof MintSwapAccountingContradictionError)) throw error;
        return this.moveToAttention(operation, 'accounting_mismatch', error.message);
      }
      return this.requireOperation(operation.id);
    });
  }

  /** Reconciles one operation from durable child and canonical quote state. */
  async refresh(operationId: string): Promise<MintSwapOperation> {
    return this.withOperationLock(operationId, () => this.refreshUnlocked(operationId));
  }

  /** Clears processor delay and immediately runs the state-specific reconciliation action. */
  async retry(operationId: string): Promise<MintSwapOperation> {
    return this.withOperationLock(operationId, async () => {
      const operation = await this.requireOperation(operationId);
      if (isTerminalMintSwapState(operation.state) || operation.state === 'needs_attention') {
        throw new Error(`Cannot retry mint swap in state ${operation.state}`);
      }
      await this.mutate(operationId, (current) => ({
        ...current,
        retry: { ...current.retry, nextAttemptAt: undefined, lastError: undefined },
      }));
      return this.refreshUnlocked(operationId);
    });
  }

  /**
   * Requests cancellation when it can still be proven value-safe.
   *
   * A prepared reservation is rolled back immediately. Once the source payment is in flight, the
   * request is persisted and reconciliation waits for canonical source-mint evidence. Cancellation
   * is rejected after destination funding because source payment is already proven.
   */
  async cancel(operationId: string, reason = 'Cancelled by caller'): Promise<MintSwapOperation> {
    return this.withOperationLock(operationId, async () => {
      const operation = await this.requireOperation(operationId);
      if (operation.state === 'destination_funded' || operation.state === 'issuing') {
        throw new Error('Cannot cancel a mint swap after destination funding');
      }
      if (isTerminalMintSwapState(operation.state) || operation.state === 'needs_attention') {
        throw new Error(`Cannot cancel mint swap in state ${operation.state}`);
      }
      if (operation.state === 'source_inflight') {
        return this.mutate(operationId, (current) => ({
          ...current,
          cancellationRequestedAt: Date.now(),
          retry: { ...current.retry, nextAttemptAt: Date.now(), lastError: reason },
        }));
      }

      if (operation.sourceMeltOperationId) {
        const wallet = await this.getWallet(operation.sourceMintUrl);
        await this.repositories.withTransaction(async (scope) => {
          await this.meltOperationService.rollbackOwnedPreparedInTransaction(
            operation.sourceMeltOperationId!,
            operation.id,
            wallet,
            scope,
            reason,
          );
          await this.casInScope(
            scope,
            operation.id,
            (current) => ({
              ...current,
              state: 'cancelled',
              cancellationRequestedAt: Date.now(),
              cancelledAt: Date.now(),
            }),
            'mint-swap-op:cancelled',
          );
        });
      } else {
        await this.mutate(
          operation.id,
          (current) => ({
            ...current,
            state: 'cancelled',
            cancellationRequestedAt: Date.now(),
            cancelledAt: Date.now(),
          }),
          'mint-swap-op:cancelled',
        );
      }
      return this.requireOperation(operation.id);
    });
  }

  /** Returns the durable parent operation, or `null` when the id is unknown. */
  get(operationId: string): Promise<MintSwapOperation | null> {
    return this.repositories.mintSwapOperationRepository.getById(operationId);
  }

  /** Lists parents, optionally filtered by state and either participating mint. */
  async list(input: ListMintSwapInput = {}): Promise<MintSwapOperation[]> {
    const operations = input.state
      ? await this.repositories.mintSwapOperationRepository.getByState(input.state)
      : await this.listAllStates();
    if (!input.mintUrl) return operations;
    const mintUrl = normalizeMintUrl(input.mintUrl);
    return operations.filter(
      (operation) =>
        operation.sourceMintUrl === mintUrl || operation.destinationMintUrl === mintUrl,
    );
  }

  /** Returns every non-terminal parent, including operations waiting for manual attention. */
  listActive(): Promise<MintSwapOperation[]> {
    return this.repositories.mintSwapOperationRepository.getActive();
  }

  /** @internal Persists durable processor backoff without changing economic state. */
  async recordProcessorFailure(
    operationId: string,
    error: string,
    nextAttemptAt: number,
  ): Promise<MintSwapOperation> {
    return this.mutate(
      operationId,
      (current) => ({
        ...current,
        retry: {
          ...current.retry,
          attemptCount: current.retry.attemptCount + 1,
          lastAttemptAt: Date.now(),
          nextAttemptAt,
          lastError: error,
        },
      }),
      'mint-swap-op:delayed',
    );
  }

  /** @internal Clears durable processor backoff after a successful canonical observation. */
  async recordProcessorSuccess(operationId: string): Promise<MintSwapOperation> {
    const operation = await this.requireOperation(operationId);
    if (
      operation.retry.attemptCount === 0 &&
      operation.retry.nextAttemptAt === undefined &&
      operation.retry.lastError === undefined
    ) {
      return operation;
    }
    return this.mutate(operationId, (current) => ({
      ...current,
      retry: {
        attemptCount: 0,
        lastAttemptAt: current.retry.lastAttemptAt,
        lastSuccessfulObservationAt: Date.now(),
      },
    }));
  }

  private async refreshUnlocked(operationId: string): Promise<MintSwapOperation> {
    const operation = await this.requireOperation(operationId);
    switch (operation.state) {
      case 'preparing':
        return this.recoverPreparing(operation);
      case 'source_inflight':
        return this.refreshSource(operation);
      case 'destination_funded':
        return this.issueDestination(operation);
      case 'issuing':
        return this.refreshDestination(operation);
      default:
        return operation;
    }
  }

  /**
   * An interrupted preparation is never resumed with a partially constructed economic plan.
   * Any linked source reservation is released atomically before the parent becomes failed.
   */
  private async recoverPreparing(operation: MintSwapOperation): Promise<MintSwapOperation> {
    if (operation.sourceMeltOperationId) {
      const wallet = await this.getWallet(operation.sourceMintUrl);
      await this.repositories.withTransaction(async (scope) => {
        await this.meltOperationService.rollbackOwnedPreparedInTransaction(
          operation.sourceMeltOperationId!,
          operation.id,
          wallet,
          scope,
          'Interrupted mint swap preparation',
        );
        await this.casInScope(
          scope,
          operation.id,
          (current) => ({
            ...current,
            state: 'failed',
            terminalFailure: {
              code: 'interrupted_preparation',
              reason: 'Mint swap preparation was interrupted before becoming executable',
              at: Date.now(),
            },
          }),
          'mint-swap-op:failed',
        );
      });
      return this.requireOperation(operation.id);
    }
    return this.markFailed(
      operation.id,
      'interrupted_preparation',
      'Mint swap preparation was interrupted before becoming executable',
    );
  }

  private async refreshSource(operation: MintSwapOperation): Promise<MintSwapOperation> {
    const child = await this.repositories.meltOperationRepository.getById(
      operation.sourceMeltOperationId!,
    );
    if (!child || child.parentSwapOperationId !== operation.id) {
      return this.moveToAttention(operation, 'ownership_conflict', 'Source child ownership failed');
    }
    if (child.state === 'finalized') {
      try {
        await this.repositories.withTransaction((scope) =>
          this.advanceSourceFundedInScope(scope, operation.id, child),
        );
      } catch (error) {
        if (!(error instanceof MintSwapAccountingContradictionError)) throw error;
        return this.moveToAttention(operation, 'accounting_mismatch', error.message);
      }
      return this.requireOperation(operation.id);
    }
    if (child.state === 'executing') {
      await this.meltOperationService.recoverOwnedExecuting(child, operation.id);
      return this.requireOperation(operation.id);
    }
    if (child.state === 'pending') {
      const canonical = await this.quoteLifecycle.getMeltQuote(
        child.mintUrl,
        child.method,
        child.quoteId,
      );
      if (canonical?.state === 'PAID') {
        await this.meltOperationService.finalize(child.id, {
          canonicalQuote: canonical,
          parentSwapOperationId: operation.id,
        });
        const finalized = await this.repositories.meltOperationRepository.getById(child.id);
        if (finalized?.state === 'finalized') {
          await this.repositories.withTransaction((scope) =>
            this.advanceSourceFundedInScope(scope, operation.id, finalized),
          );
        }
      } else if (canonical?.state === 'UNPAID' && operation.cancellationRequestedAt) {
        await this.meltOperationService.rollback(child.id, 'Mint swap cancellation requested', {
          canonicalQuote: canonical,
          parentSwapOperationId: operation.id,
        });
        await this.markCancelled(operation.id);
      } else {
        await this.quoteLifecycle.refreshMeltQuote(child.mintUrl, child.method, child.quoteId);
      }
      return this.requireOperation(operation.id);
    }
    if (child.state === 'rolled_back') {
      if (operation.cancellationRequestedAt) return this.markCancelled(operation.id);
      return this.markFailed(operation.id, 'source_reclaimed', 'Source value was reclaimed');
    }
    return this.moveToAttention(
      operation,
      'accounting_mismatch',
      `Unexpected source child state ${child.state}`,
    );
  }

  private async issueDestination(operation: MintSwapOperation): Promise<MintSwapOperation> {
    // As with the source leg, durable authorization precedes remote issuance.
    let executingChild!: ExecutingMintOperation;
    await this.repositories.withTransaction(async (scope) => {
      executingChild = await this.mintOperationService.authorizeOwnedExecutionInTransaction(
        operation.destinationMintOperationId!,
        operation.id,
        scope,
      );
      await this.casInScope(
        scope,
        operation.id,
        (current) => ({
          ...current,
          state: 'issuing',
          destinationIssueAuthorizedAt: Date.now(),
        }),
        'mint-swap-op:issuing',
      );
    });
    const result = await this.mintOperationService.executeOwnedRemote(executingChild, operation.id);
    try {
      await this.repositories.withTransaction(async (scope) => {
        const child = await this.mintOperationService.applyOwnedExecutionInTransaction(
          executingChild,
          operation.id,
          result,
          scope,
        );
        if (child.state === 'finalized') {
          await this.completeInScope(scope, operation.id, child);
        }
      });
    } catch (error) {
      if (!(error instanceof MintSwapAccountingContradictionError)) throw error;
      return this.moveToAttention(operation, 'accounting_mismatch', error.message);
    }
    return this.requireOperation(operation.id);
  }

  private async refreshDestination(operation: MintSwapOperation): Promise<MintSwapOperation> {
    const child = await this.repositories.mintOperationRepository.getById(
      operation.destinationMintOperationId!,
    );
    if (!child || child.parentSwapOperationId !== operation.id) {
      return this.moveToAttention(
        operation,
        'ownership_conflict',
        'Destination child ownership failed',
      );
    }
    if (child.state === 'finalized') {
      try {
        await this.repositories.withTransaction((scope) =>
          this.completeInScope(scope, operation.id, child),
        );
      } catch (error) {
        if (!(error instanceof MintSwapAccountingContradictionError)) throw error;
        return this.moveToAttention(operation, 'accounting_mismatch', error.message);
      }
    } else if (child.state === 'executing') {
      await this.mintOperationService.recoverOwnedExecuting(child, operation.id);
    } else if (child.state === 'pending') {
      return this.retryDestinationIssue(operation, child.id);
    } else if (child.state === 'failed') {
      return this.moveToAttention(
        operation,
        'source_paid_destination_terminal',
        'Destination child became terminal after source payment',
      );
    }
    return this.requireOperation(operation.id);
  }

  private async retryDestinationIssue(
    operation: MintSwapOperation,
    childId: string,
  ): Promise<MintSwapOperation> {
    let executing!: ExecutingMintOperation;
    await this.repositories.withTransaction(async (scope) => {
      executing = await this.mintOperationService.authorizeOwnedExecutionInTransaction(
        childId,
        operation.id,
        scope,
      );
      await this.casInScope(scope, operation.id, (current) => ({
        ...current,
        destinationIssueAuthorizedAt: current.destinationIssueAuthorizedAt ?? Date.now(),
      }));
    });
    const result = await this.mintOperationService.executeOwnedRemote(executing, operation.id);
    await this.repositories.withTransaction(async (scope) => {
      const finalized = await this.mintOperationService.applyOwnedExecutionInTransaction(
        executing,
        operation.id,
        result,
        scope,
      );
      if (finalized.state === 'finalized') {
        await this.completeInScope(scope, operation.id, finalized);
      }
    });
    return this.requireOperation(operation.id);
  }

  private async advanceSourceFundedInScope(
    scope: RepositoryTransactionScope,
    operationId: string,
    child: FinalizedMeltOperation,
  ): Promise<void> {
    const current = await this.requireOperationInScope(scope, operationId);
    if (current.state === 'destination_funded' || current.state === 'issuing') return;
    // Settlement and the funded event commit together; listeners never see unvalidated accounting.
    const settlement = this.calculateSettlement(current, child);
    const next = await this.casInScope(
      scope,
      operationId,
      (operation) => ({ ...operation, state: 'destination_funded', settlement }),
      'mint-swap-op:destination-funded',
    );
    try {
      validateMintSwapAccounting(next);
    } catch (error) {
      throw new MintSwapAccountingContradictionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async completeInScope(
    scope: RepositoryTransactionScope,
    operationId: string,
    child: FinalizedMintOperation,
  ): Promise<void> {
    const current = await this.requireOperationInScope(scope, operationId);
    if (current.state === 'completed') return;
    // Completion is authorized by durable proof value, not merely by a finalized child state.
    const proofs = await scope.proofRepository.getProofsByOperationId(child.mintUrl, child.id);
    const issued = sumProofs(proofs.filter((proof) => proof.createdByOperationId === child.id));
    if (!issued.equals(current.destinationAmount)) {
      throw new MintSwapAccountingContradictionError(
        'Destination proof total does not match mint swap amount',
      );
    }
    const settlement = { ...current.settlement!, destinationAmountIssued: issued };
    const next = await this.casInScope(
      scope,
      operationId,
      (operation) => ({
        ...operation,
        state: 'completed',
        settlement,
        completedAt: Date.now(),
      }),
      'mint-swap-op:completed',
    );
    try {
      validateMintSwapAccounting(next);
    } catch (error) {
      throw new MintSwapAccountingContradictionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private calculateSettlement(
    operation: MintSwapOperation,
    child: FinalizedMeltOperation,
  ): MintSwapSettlement {
    const plan = operation.preparedPlan!;
    if (child.effectiveFee === undefined) {
      throw new MintSwapAccountingContradictionError(
        'Finalized source child is missing effective fee accounting',
      );
    }
    if (child.effectiveFee.lessThan(plan.sourceMeltInputFee)) {
      throw new MintSwapAccountingContradictionError(
        'Source effective fee is below its melt input fee',
      );
    }
    // Melt effectiveFee combines the melt-input fee and the settled payment-side cost.
    const sourcePaymentFee = child.effectiveFee.subtract(plan.sourceMeltInputFee);
    const totalSourceFee = plan.sourcePreparationFee
      .add(plan.sourceMeltInputFee)
      .add(sourcePaymentFee);
    const sourceMeltChangeAmount = child.changeAmount ?? Amount.zero();
    const sourceKeepAmount = this.sourceKeepAmount(child);
    const sourceReturnedAmount = sourceKeepAmount.add(sourceMeltChangeAmount);
    // Debit is derived independently from returned value; the model validator also requires it to
    // equal destinationAmount + totalSourceFee and remain within the accepted maximum.
    const finalSourceDebit = plan.reservedSourceAmount.subtract(sourceReturnedAmount);
    return {
      sourcePaymentFee,
      totalSourceFee,
      sourceMeltChangeAmount,
      sourceKeepAmount,
      sourceReturnedAmount,
      finalSourceDebit,
    };
  }

  private async buildPreparedPlan(
    sourceChild: PreparedMeltOperation,
    destinationOutputData: unknown,
    destinationQuote: MintQuote<'bolt11'>,
    sourceQuote: MeltQuote<'bolt11'>,
    sourceWallet: Wallet,
    sourceSupportsNut08: boolean,
    requiredDispatchWindowSeconds: number | undefined,
    scope: RepositoryTransactionScope,
  ): Promise<MintSwapPreparedPlan> {
    const reservedProofs = (
      await scope.proofRepository.getProofsByOperationId(sourceChild.mintUrl, sourceChild.id)
    ).filter((proof) => proof.usedByOperationId === sourceChild.id);
    const sourcePreparationFee = sourceChild.swap_fee;
    const sourceMeltInputFee = this.sourceMeltInputFee(sourceChild, reservedProofs, sourceWallet);
    const sourceKeepAmount = this.sourceKeepAmount(sourceChild);
    // The minimum contains only exact, known costs. fee_reserve is not treated as an estimate.
    const minimumSourceDebit = sourceChild.amount.add(sourcePreparationFee).add(sourceMeltInputFee);
    // A pre-swap removes denomination overage into local keep proofs. A direct NUT-08 plan can
    // bound payment cost by fee_reserve; without NUT-08 the whole selected input is the safe bound.
    const maximumSourceDebit = sourceChild.needsSwap
      ? sourceChild.inputAmount.subtract(sourceKeepAmount)
      : sourceSupportsNut08
        ? minimumSourceDebit.add(sourceChild.fee_reserve)
        : sourceChild.inputAmount;
    if (maximumSourceDebit.greaterThan(sourceChild.inputAmount)) {
      throw new Error('Prepared source plan does not reserve its maximum debit');
    }
    const dispatch = evaluateMintSwapDispatchWindow({
      expiries: [destinationQuote.expiry, sourceQuote.expiry],
      requiredWindowSeconds: requiredDispatchWindowSeconds,
    });
    if (!dispatch.canDispatch) throw new Error('Mint swap quote expiry window is too short');
    const current = await this.requireOperationInScope(scope, sourceChild.parentSwapOperationId!);
    const fingerprint = createMintSwapPreparedPlanFingerprint({
      destinationMintOperationId: current.destinationMintOperationId!,
      sourceMeltOperationId: sourceChild.id,
      destinationQuoteRef: current.destinationQuoteRef!,
      sourceQuoteRef: current.sourceQuoteRef!,
      destinationAmount: current.destinationAmount,
      unit: 'sat',
      sourceInputProofSecrets: sourceChild.inputProofSecrets,
      destinationOutputData,
      sourceOutputData: {
        changeOutputData: sourceChild.changeOutputData,
        swapOutputData: sourceChild.swapOutputData,
      },
      maximumSourceDebit,
    });
    return {
      fingerprint,
      dispatchDeadline: dispatch.dispatchDeadline,
      requiredDispatchWindowSeconds: dispatch.requiredWindowSeconds,
      sourceMeltAmount: sourceChild.amount,
      sourceFeeReserve: sourceChild.fee_reserve,
      sourcePreparationFee,
      sourceMeltInputFee,
      minimumSourceDebit,
      maximumSourceDebit,
      reservedSourceAmount: sourceChild.inputAmount,
    };
  }

  private sourceMeltInputFee(
    child: PreparedMeltOperation,
    reservedProofs: Proof[],
    wallet: Wallet,
  ): Amount {
    if (!child.needsSwap) return wallet.getFeesForProofs(reservedProofs);
    if (!child.swapOutputData) throw new Error('Source pre-swap output plan is missing');
    // Pre-swap send outputs were constructed as amount + reserve + future melt-input fee.
    const meltInputAmount = OutputData.sumOutputAmounts(
      deserializeOutputData(child.swapOutputData).send,
    );
    return meltInputAmount.subtract(child.amount).subtract(child.fee_reserve);
  }

  private sourceKeepAmount(child: PreparedMeltOperation | FinalizedMeltOperation): Amount {
    if (!child.needsSwap) return Amount.zero();
    if (!child.swapOutputData) throw new Error('Source pre-swap output plan is missing');
    return OutputData.sumOutputAmounts(deserializeOutputData(child.swapOutputData).keep);
  }

  private async assertPreflight(
    sourceMintUrl: string,
    destinationMintUrl: string,
    amount: Amount,
  ): Promise<void> {
    const [sourceTrusted, destinationTrusted] = await Promise.all([
      this.mintService.isTrustedMint(sourceMintUrl),
      this.mintService.isTrustedMint(destinationMintUrl),
    ]);
    if (!sourceTrusted || !destinationTrusted) {
      throw new Error('Mint swap requires two explicitly trusted mints');
    }
    await Promise.all([
      this.mintService.assertMethodUnitSupported(destinationMintUrl, 4, 'bolt11', {
        amount,
        unit: 'sat',
      }),
      this.mintService.assertMethodUnitSupported(sourceMintUrl, 5, 'bolt11', {
        amount,
        unit: 'sat',
      }),
      this.mintService.assertNutSupported(sourceMintUrl, 7, 'mint swap recovery'),
      this.mintService.assertNutSupported(sourceMintUrl, 9, 'mint swap recovery'),
      this.mintService.assertNutSupported(destinationMintUrl, 9, 'mint swap recovery'),
      this.mintService.assertNutSupported(destinationMintUrl, 20, 'mint swap destination claim'),
    ]);
  }

  private assertDestinationQuote(
    quote: MintQuote,
    amount: Amount,
    expectedPublicKey: string,
  ): asserts quote is MintQuote<'bolt11'> {
    if (
      quote.method !== 'bolt11' ||
      quote.unit !== 'sat' ||
      !quote.amount.equals(amount) ||
      quote.pubkey !== expectedPublicKey
    ) {
      throw new Error('Destination quote does not match the mint swap intent');
    }
  }

  private assertSourceQuote(
    quote: MeltQuote,
    amount: Amount,
  ): asserts quote is MeltQuote<'bolt11'> {
    if (quote.method !== 'bolt11' || quote.unit !== 'sat' || !quote.amount.equals(amount)) {
      throw new Error('Source quote does not match the mint swap intent');
    }
  }

  private assertDispatchWindow(operation: MintSwapOperation): void {
    const plan = operation.preparedPlan!;
    const dispatch = evaluateMintSwapDispatchWindow({
      expiries: [plan.dispatchDeadline],
      requiredWindowSeconds: plan.requiredDispatchWindowSeconds,
    });
    if (!dispatch.canDispatch) throw new Error('Mint swap dispatch window has expired');
  }

  private quoteRef(quote: MintQuote<'bolt11'> | MeltQuote<'bolt11'>) {
    return { mintUrl: quote.mintUrl, method: 'bolt11' as const, quoteId: quote.quoteId };
  }

  private async getWallet(mintUrl: string): Promise<Wallet> {
    return (await this.walletService.getWalletWithActiveKeysetId(mintUrl, 'sat')).wallet;
  }

  private async failPreparation(operationId: string): Promise<void> {
    try {
      const operation = await this.get(operationId);
      if (!operation || operation.state !== 'preparing') return;
      await this.mutate(
        operationId,
        (current) => ({
          ...current,
          state: 'failed',
          terminalFailure: {
            code: 'preparation_failed',
            reason: 'Mint swap preparation failed before source dispatch',
            at: Date.now(),
          },
        }),
        'mint-swap-op:failed',
      );
    } catch (error) {
      this.logger?.warn('Failed to persist mint swap preparation failure', {
        operationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async moveToAttention(
    operation: MintSwapOperation,
    reason: 'ownership_conflict' | 'accounting_mismatch' | 'source_paid_destination_terminal',
    message: string,
  ): Promise<MintSwapOperation> {
    return this.mutate(
      operation.id,
      (current) => ({
        ...current,
        state: 'needs_attention',
        attention: {
          reason,
          message,
          lastSafeState: current.state,
          violatedInvariant: reason,
          evidence: { operationId: current.id },
          at: Date.now(),
        },
      }),
      'mint-swap-op:needs-attention',
    );
  }

  private async markCancelled(operationId: string): Promise<MintSwapOperation> {
    return this.mutate(
      operationId,
      (current) => ({
        ...current,
        state: 'cancelled',
        cancellationRequestedAt: current.cancellationRequestedAt ?? Date.now(),
        cancelledAt: Date.now(),
      }),
      'mint-swap-op:cancelled',
    );
  }

  private async markFailed(
    operationId: string,
    code: string,
    reason: string,
  ): Promise<MintSwapOperation> {
    return this.mutate(
      operationId,
      (current) => ({
        ...current,
        state: 'failed',
        terminalFailure: { code, reason, at: Date.now() },
      }),
      'mint-swap-op:failed',
    );
  }

  private async mutate(
    operationId: string,
    mutation: (current: MintSwapOperation) => MintSwapOperation,
    eventType?: MintSwapEventType,
  ): Promise<MintSwapOperation> {
    return this.repositories.withTransaction((scope) =>
      this.casInScope(scope, operationId, mutation, eventType),
    );
  }

  private async casInScope(
    scope: RepositoryTransactionScope,
    operationId: string,
    mutation: (current: MintSwapOperation) => MintSwapOperation,
    eventType?: MintSwapEventType,
  ): Promise<MintSwapOperation> {
    const current = await this.requireOperationInScope(scope, operationId);
    const next = mutation(current);
    next.revision = current.revision + 1;
    next.updatedAt = Date.now();
    if (!(await scope.mintSwapOperationRepository.compareAndSet(next, current.revision))) {
      throw new Error(`Concurrent mint swap update for ${operationId}`);
    }
    // Parent state and its logical event are atomic; publication happens after this transaction.
    if (eventType) await scope.operationEventOutboxRepository.enqueue(this.outbox(next, eventType));
    return next;
  }

  private outbox(
    operation: MintSwapOperation,
    eventType: MintSwapEventType,
  ): OperationEventOutboxRecord {
    return {
      id: generateSubId(),
      operationId: operation.id,
      revision: operation.revision,
      eventType,
      payload: {
        operationId: operation.id,
        revision: operation.revision,
        state: operation.state,
        sourceMintUrl: operation.sourceMintUrl,
        destinationMintUrl: operation.destinationMintUrl,
        unit: operation.unit,
        destinationAmount: operation.destinationAmount.toString(),
        reasonCode: operation.attention?.reason ?? operation.terminalFailure?.code,
      },
      createdAt: Date.now(),
      publishAttempts: 0,
    };
  }

  private requireOperation(operationId: string): Promise<MintSwapOperation> {
    return this.requireOperationInScope(this.repositories, operationId);
  }

  private async requireOperationInScope(
    scope: Pick<RepositoryTransactionScope, 'mintSwapOperationRepository'>,
    operationId: string,
  ): Promise<MintSwapOperation> {
    const operation = await scope.mintSwapOperationRepository.getById(operationId);
    if (!operation) throw new Error(`Mint swap ${operationId} not found`);
    return operation;
  }

  private async listAllStates(): Promise<MintSwapOperation[]> {
    const states: MintSwapOperationState[] = [
      'preparing',
      'prepared',
      'source_inflight',
      'destination_funded',
      'issuing',
      'completed',
      'cancelled',
      'failed',
      'needs_attention',
    ];
    const groups = await Promise.all(
      states.map((state) => this.repositories.mintSwapOperationRepository.getByState(state)),
    );
    return groups.flat().sort((left, right) => left.createdAt - right.createdAt);
  }

  private async withOperationLock<T>(operationId: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.operationLock.acquire(operationId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async withMintLock<T>(mintUrl: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.mintScopedLock.acquire(mintUrl);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
