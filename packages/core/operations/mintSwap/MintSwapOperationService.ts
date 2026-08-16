import { Amount, type AmountLike, type Proof, type Wallet } from '@cashu/cashu-ts';

import type { Logger } from '../../logging/Logger.ts';
import { getMintQuoteAmount, type MintQuote } from '../../models/MintQuote.ts';
import type { MeltQuote } from '../../models/MeltQuote.ts';
import type { OperationEventOutboxRecord } from '../../models/OperationEventOutbox.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import type { Repositories, RepositoryTransactionScope } from '../../repositories/index.ts';
import { requireMintSwapRepositoryCapability } from '../../repositories/index.ts';
import type { KeyRingService } from '../../services/KeyRingService.ts';
import type { MintService } from '../../services/MintService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import { generateSubId, normalizeMintUrl } from '../../utils.ts';
import type { MeltOperationService } from '../melt/MeltOperationService.ts';
import type {
  ExecutingMeltOperation,
  FailedMeltOperation,
  FinalizedMeltOperation,
  PreparedMeltOperation,
} from '../melt/MeltOperation.ts';
import type { OwnedMeltRemoteResult } from '../melt/MeltMethodHandler.ts';
import type { MintOperationService } from '../mint/MintOperationService.ts';
import type {
  ExecutingMintOperation,
  FinalizedMintOperation,
  PendingMintOperation,
} from '../mint/MintOperation.ts';
import {
  assertMintSwapPreparationLeaseOwner,
  createMintSwapPreparedPlanFingerprint,
  isAutomaticMintSwapState,
  isMintSwapPreparationLeaseActive,
  isTerminalMintSwapState,
  validateMintSwapAccounting,
  type MintSwapAttentionReason,
  type MintSwapEventType,
  type MintSwapOperation,
  type MintSwapOperationState,
  type MintSwapPreparationLease,
  type MintSwapPreparedPlan,
  type MintSwapSettlement,
} from './MintSwapOperation.ts';
import {
  DEFAULT_MINT_SWAP_DISPATCH_WINDOW_SECONDS,
  evaluateMintSwapDispatchWindow,
} from './MintSwapPolicy.ts';

export interface PrepareMintSwapInput {
  sourceMintUrl: string;
  destinationMintUrl: string;
  amount: AmountLike;
  unit?: 'sat';
  requiredDispatchWindowSeconds?: number;
}

export interface ListMintSwapInput {
  state?: MintSwapOperationState;
  mintUrl?: string;
}

export interface MintSwapOperationServiceOptions {
  now?: () => number;
  workerId?: string;
  leaseDurationMs?: number;
  generateId?: () => string;
}

export class MintSwapPreparationError extends Error {
  readonly operationId: string;

  constructor(operationId: string, cause: unknown) {
    super(`Mint swap ${operationId} could not be prepared`, {
      cause: new Error('Mint swap preparation failed; inspect durable operation state'),
    });
    this.name = 'MintSwapPreparationError';
    this.operationId = operationId;
    void cause;
  }
}

class MintSwapCasError extends Error {}

/** Internal, dormant coordinator for the durable exact-receive Mint Swap saga. */
export class MintSwapOperationService {
  private readonly now: () => number;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly generateId: () => string;

  constructor(
    private readonly repositories: Repositories,
    private readonly quoteLifecycle: QuoteLifecycle,
    private readonly mintOperationService: MintOperationService,
    private readonly meltOperationService: MeltOperationService,
    private readonly mintService: MintService,
    private readonly walletService: WalletService,
    private readonly keyRingService: KeyRingService,
    private readonly logger?: Logger,
    options: MintSwapOperationServiceOptions = {},
  ) {
    requireMintSwapRepositoryCapability(repositories);
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? generateSubId;
    this.workerId = options.workerId ?? `mint-swap-worker:${this.generateId()}`;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs <= 0) {
      throw new Error('Mint swap preparation lease duration must be a positive safe integer');
    }
  }

  async prepare(input: PrepareMintSwapInput): Promise<MintSwapOperation> {
    const sourceMintUrl = normalizeMintUrl(input.sourceMintUrl);
    const destinationMintUrl = normalizeMintUrl(input.destinationMintUrl);
    const destinationAmount = Amount.from(input.amount);
    if ((input.unit ?? 'sat') !== 'sat') throw new Error('Mint swaps support only sat');
    if (destinationAmount.isZero() || destinationAmount.toString().startsWith('-')) {
      throw new Error('Mint swap destination amount must be positive');
    }
    if (sourceMintUrl === destinationMintUrl) {
      throw new Error('Mint swap source and destination mints must be distinct');
    }
    await this.assertPreflight(sourceMintUrl, destinationMintUrl, destinationAmount);
    const requiredDispatchWindowSeconds =
      input.requiredDispatchWindowSeconds ?? DEFAULT_MINT_SWAP_DISPATCH_WINDOW_SECONDS;
    if (
      !Number.isSafeInteger(requiredDispatchWindowSeconds) ||
      requiredDispatchWindowSeconds < 30
    ) {
      throw new Error('Mint swap dispatch window must be at least 30 seconds');
    }

    const keyPair = await this.keyRingService.generateMintQuoteKeyPair();
    if (keyPair.derivationIndex === undefined) {
      throw new Error('Mint swap NUT-20 key is missing its derivation index');
    }
    const operationId = this.generateId();
    const now = this.now();
    const initial: MintSwapOperation = {
      id: operationId,
      state: 'preparing',
      revision: 0,
      sourceMintUrl,
      destinationMintUrl,
      unit: 'sat',
      destinationAmount,
      requiredDispatchWindowSeconds,
      destinationNut20Key: {
        publicKey: keyPair.publicKeyHex,
        derivationIndex: keyPair.derivationIndex,
      },
      preparationLease: this.newLease('destination_quote', now),
      retry: { attemptCount: 0 },
      createdAt: now,
      updatedAt: now,
    };
    await this.parentRepository().create(initial);

    try {
      return await this.resumePreparation(operationId);
    } catch (error) {
      await this.failPreparation(operationId, error);
      throw new MintSwapPreparationError(operationId, error);
    }
  }

  async get(operationId: string): Promise<MintSwapOperation | null> {
    return this.parentRepository().getById(operationId);
  }

  async list(input: ListMintSwapInput = {}): Promise<MintSwapOperation[]> {
    const operations = input.state
      ? await this.parentRepository().getByState(input.state)
      : await this.listAllStates();
    if (!input.mintUrl) return operations;
    const mintUrl = normalizeMintUrl(input.mintUrl);
    return operations.filter(
      (operation) =>
        operation.sourceMintUrl === mintUrl || operation.destinationMintUrl === mintUrl,
    );
  }

  async listActive(): Promise<MintSwapOperation[]> {
    return this.parentRepository().getActive();
  }

  async execute(operationId: string): Promise<MintSwapOperation> {
    const current = await this.requireOperation(operationId);
    if (current.state !== 'prepared') return this.reconcile(operationId);
    try {
      await this.assertPreparedPlan(current);
    } catch {
      return this.moveToAttention(
        current,
        'prepared_plan_mismatch',
        'Mint swap child data no longer matches its authorized prepared plan',
        'prepared plan fingerprint and ownership',
      );
    }
    try {
      this.assertDispatchWindow(current);
    } catch {
      return this.failPreparedBeforeDispatch(current);
    }

    const authorized = await this.repositories.withTransaction(async (scope) => {
      const operation = await this.requireOperationInScope(scope, operationId);
      if (operation.state !== 'prepared') return false;
      await this.meltOperationService.authorizeOwnedExecutionInTransaction(
        operation.sourceMeltOperationId!,
        operation.id,
        scope,
      );
      const now = this.now();
      await this.replaceInScope(
        scope,
        operation,
        {
          ...operation,
          state: 'source_inflight',
          sourceDispatchAuthorizedAt: now,
          retry: {
            ...operation.retry,
            attemptCount: 0,
            lastError: undefined,
            lastSuccessfulObservationAt: now,
            nextAttemptAt: now + this.leaseDurationMs,
          },
        },
        'mint-swap-op:source-inflight',
      );
      return true;
    });
    if (!authorized) return this.reconcile(operationId);
    return this.driveSource(operationId, true);
  }

  async reconcile(operationId: string): Promise<MintSwapOperation> {
    const operation = await this.requireOperation(operationId);
    switch (operation.state) {
      case 'preparing':
        return this.resumePreparation(operationId);
      case 'prepared':
      case 'completed':
      case 'cancelled':
      case 'failed':
      case 'needs_attention':
        return operation;
      case 'source_inflight':
        if ((operation.retry.nextAttemptAt ?? 0) > this.now()) return operation;
        return this.driveSource(operationId, false);
      case 'destination_funded':
        if ((operation.retry.nextAttemptAt ?? 0) > this.now()) return operation;
        return this.authorizeAndIssueDestination(operationId);
      case 'issuing':
        if ((operation.retry.nextAttemptAt ?? 0) > this.now()) return operation;
        return this.issueDestination(operationId);
    }
  }

  async cancel(operationId: string, reason = 'Cancelled by caller'): Promise<MintSwapOperation> {
    const requestedAt = this.now();
    return this.repositories.withTransaction(async (scope) => {
      const operation = await this.requireOperationInScope(scope, operationId);
      if (isTerminalMintSwapState(operation.state) || operation.state === 'needs_attention') {
        return operation;
      }
      if (operation.state === 'prepared') {
        await this.meltOperationService.rollbackOwnedPreparedInTransaction(
          operation.sourceMeltOperationId!,
          operation.id,
          scope,
          reason,
        );
        return this.replaceInScope(
          scope,
          operation,
          {
            ...operation,
            state: 'cancelled',
            cancellationRequestedAt: requestedAt,
            cancelledAt: requestedAt,
          },
          'mint-swap-op:cancelled',
        );
      }
      if (operation.state === 'preparing') {
        return this.replaceInScope(
          scope,
          operation,
          {
            ...operation,
            state: 'cancelled',
            preparationLease: undefined,
            cancellationRequestedAt: requestedAt,
            cancelledAt: requestedAt,
          },
          'mint-swap-op:cancelled',
        );
      }
      if (operation.cancellationRequestedAt !== undefined) return operation;
      return this.replaceInScope(scope, operation, {
        ...operation,
        cancellationRequestedAt: requestedAt,
      });
    });
  }

  private async resumePreparation(operationId: string): Promise<MintSwapOperation> {
    for (let step = 0; step < 12; step++) {
      let operation = await this.requireOperation(operationId);
      if (operation.state !== 'preparing') return operation;
      operation = await this.claimPreparationLease(operation);
      if (operation.state !== 'preparing') return operation;
      const lease = operation.preparationLease!;

      switch (lease.stage) {
        case 'destination_quote':
          await this.prepareDestinationQuote(operation, lease);
          break;
        case 'destination_child':
          await this.prepareDestinationChild(operation, lease);
          break;
        case 'source_quote':
          await this.prepareSourceQuote(operation, lease);
          break;
        case 'source_child':
          await this.prepareSourceChild(operation, lease);
          break;
      }
    }
    throw new Error(`Mint swap ${operationId} preparation did not converge`);
  }

  private async claimPreparationLease(operation: MintSwapOperation): Promise<MintSwapOperation> {
    const now = this.now();
    const lease = operation.preparationLease!;
    if (isMintSwapPreparationLeaseActive(operation, now)) {
      if (lease.ownerId !== this.workerId) {
        throw new Error(`Mint swap ${operation.id} preparation is leased by another worker`);
      }
      return operation;
    }
    const next: MintSwapOperation = {
      ...operation,
      revision: operation.revision + 1,
      updatedAt: now,
      preparationLease: this.newLease(lease.stage, now),
    };
    if (!(await this.parentRepository().compareAndSet(next, operation.revision))) {
      return this.requireOperation(operation.id);
    }
    return next;
  }

  private async prepareDestinationQuote(
    operation: MintSwapOperation,
    lease: MintSwapPreparationLease,
  ): Promise<void> {
    const quote = await this.quoteLifecycle.createMintQuote(
      operation.destinationMintUrl,
      'bolt11',
      {
        amount: { amount: operation.destinationAmount, unit: 'sat' },
        ownedPubkey: operation.destinationNut20Key.publicKey,
      },
    );
    this.assertDestinationQuote(quote, operation);
    await this.advancePreparation(operation.id, lease, {
      destinationQuoteRef: this.quoteRef(quote),
      nextStage: 'destination_child',
    });
  }

  private async prepareDestinationChild(
    operation: MintSwapOperation,
    lease: MintSwapPreparationLease,
  ): Promise<void> {
    const quote = await this.requireDestinationQuote(operation);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
      operation.destinationMintUrl,
      'sat',
    );
    const operationId = this.childId(operation.id, 'destination');
    const child = await this.mintOperationService.planOwnedPreparation({
      operationId,
      parentSwapOperationId: operation.id,
      quote,
      amount: operation.destinationAmount,
      destinationNut20PublicKey: operation.destinationNut20Key.publicKey,
      wallet,
    });

    await this.repositories.withTransaction(async (scope) => {
      const current = await this.requirePreparingLeaseInScope(scope, operation.id, lease);
      await this.mintOperationService.prepareOwnedInTransaction({
        operationId,
        parentSwapOperationId: current.id,
        quote,
        amount: current.destinationAmount,
        destinationNut20PublicKey: current.destinationNut20Key.publicKey,
        preparedOperation: child,
        repositories: scope,
      });
      await this.replaceInScope(scope, current, {
        ...current,
        destinationMintOperationId: operationId,
        preparationLease: this.advanceLease(current.preparationLease!, 'source_quote'),
      });
    });
  }

  private async prepareSourceQuote(
    operation: MintSwapOperation,
    lease: MintSwapPreparationLease,
  ): Promise<void> {
    const destinationQuote = await this.requireDestinationQuote(operation);
    const quote = await this.quoteLifecycle.createMeltQuote(
      operation.sourceMintUrl,
      'bolt11',
      { invoice: destinationQuote.request },
      'sat',
    );
    this.assertSourceQuote(quote, destinationQuote, operation);
    await this.advancePreparation(operation.id, lease, {
      sourceQuoteRef: this.quoteRef(quote),
      nextStage: 'source_child',
    });
  }

  private async prepareSourceChild(
    operation: MintSwapOperation,
    lease: MintSwapPreparationLease,
  ): Promise<void> {
    const [destinationQuote, sourceQuote, sourceWalletResult] = await Promise.all([
      this.requireDestinationQuote(operation),
      this.requireSourceQuote(operation),
      this.walletService.getWalletWithActiveKeysetId(operation.sourceMintUrl, 'sat'),
    ]);
    const sourceWallet = sourceWalletResult.wallet;
    const operationId = this.childId(operation.id, 'source');
    const child = await this.meltOperationService.planOwnedPreparation({
      operationId,
      parentSwapOperationId: operation.id,
      quote: sourceQuote,
      wallet: sourceWallet,
    });
    const plan = await this.buildPreparedPlan(
      operation,
      child,
      destinationQuote,
      sourceQuote,
      sourceWallet,
      operation.requiredDispatchWindowSeconds,
    );

    await this.repositories.withTransaction(async (scope) => {
      const current = await this.requirePreparingLeaseInScope(scope, operation.id, lease);
      await this.meltOperationService.prepareOwnedInTransaction({
        operationId,
        parentSwapOperationId: current.id,
        quote: sourceQuote,
        preparedOperation: child,
        repositories: scope,
      });
      const destinationChild = await scope.mintOperationRepository.getById(
        current.destinationMintOperationId!,
      );
      if (!destinationChild || !('outputData' in destinationChild)) {
        throw new Error('Mint swap destination child recovery material is missing');
      }
      const preparedPlan: MintSwapPreparedPlan = {
        ...plan,
        fingerprint: createMintSwapPreparedPlanFingerprint({
          destinationMintOperationId: destinationChild.id,
          sourceMeltOperationId: child.id,
          destinationQuoteRef: current.destinationQuoteRef!,
          sourceQuoteRef: current.sourceQuoteRef!,
          destinationNut20Key: current.destinationNut20Key,
          destinationAmount: current.destinationAmount,
          unit: 'sat',
          sourceInputProofSecrets: child.inputProofSecrets,
          destinationOutputData: destinationChild.outputData,
          sourceOutputData: this.sourceOutputData(child),
          ...plan,
        }),
      };
      await this.replaceInScope(
        scope,
        current,
        {
          ...current,
          state: 'prepared',
          preparationLease: undefined,
          sourceMeltOperationId: operationId,
          preparedPlan,
          retry: {
            ...current.retry,
            attemptCount: 0,
            nextAttemptAt: undefined,
            lastError: undefined,
            lastSuccessfulObservationAt: this.now(),
          },
        },
        'mint-swap-op:prepared',
      );
    });
  }

  private async advancePreparation(
    operationId: string,
    lease: MintSwapPreparationLease,
    change:
      | {
          destinationQuoteRef: MintSwapOperation['destinationQuoteRef'];
          nextStage: 'destination_child';
        }
      | { sourceQuoteRef: MintSwapOperation['sourceQuoteRef']; nextStage: 'source_child' },
  ): Promise<void> {
    await this.repositories.withTransaction(async (scope) => {
      const current = await this.requirePreparingLeaseInScope(scope, operationId, lease);
      await this.replaceInScope(scope, current, {
        ...current,
        ...('destinationQuoteRef' in change
          ? { destinationQuoteRef: change.destinationQuoteRef }
          : { sourceQuoteRef: change.sourceQuoteRef }),
        preparationLease: this.advanceLease(current.preparationLease!, change.nextStage),
      });
    });
  }

  private async driveSource(
    operationId: string,
    dispatchAuthorizedStep: boolean,
  ): Promise<MintSwapOperation> {
    const parent = await this.requireOperation(operationId);
    if (parent.state !== 'source_inflight') return parent;
    const child = await this.repositories.meltOperationRepository.getById(
      parent.sourceMeltOperationId!,
    );
    if (!child || child.parentSwapOperationId !== parent.id) {
      return this.moveToAttention(
        parent,
        'ownership_conflict',
        'Mint swap source child ownership no longer matches its parent',
        'source child ownership',
      );
    }
    if (child.state === 'finalized') return this.advanceSourceFunded(parent, child);
    if (child.state === 'failed') return this.finishReclaimedSource(parent, this.now());
    if (child.state === 'pending') dispatchAuthorizedStep = false;
    if (child.state !== 'executing' && child.state !== 'pending') {
      return this.moveToAttention(
        parent,
        'canonical_observation_conflict',
        'Mint swap source child is in an unexpected state',
        'source child progress state',
        { childState: child.state },
      );
    }

    try {
      if (!dispatchAuthorizedStep) {
        const observation = await this.meltOperationService.observeOwnedRecovery(
          child.id,
          parent.id,
        );
        if (observation.status === 'ORIGINAL_INPUTS_RECLAIMABLE') {
          return this.repositories.withTransaction(async (scope) => {
            const current = await this.requireOperationInScope(scope, parent.id);
            if (current.state !== 'source_inflight') return current;
            await this.meltOperationService.reclaimOwnedPreSwapInTransaction(
              child.id,
              parent.id,
              scope,
            );
            return this.finishReclaimedSourceInScope(scope, current, observation.observedAt);
          });
        }
        return this.applySourceResult(parent.id, observation.result);
      }
      const result = await this.meltOperationService.executeOwnedRemoteStep(child.id, parent.id);
      return this.applySourceResult(parent.id, result);
    } catch (error) {
      throw error;
    }
  }

  private async applySourceResult(
    parentId: string,
    result: OwnedMeltRemoteResult,
  ): Promise<MintSwapOperation> {
    const outcome = await this.repositories.withTransaction(async (scope) => {
      const parent = await this.requireOperationInScope(scope, parentId);
      if (parent.state !== 'source_inflight') return { parent, child: null };
      const child = await this.meltOperationService.applyOwnedRemoteStepInTransaction(
        parent.sourceMeltOperationId!,
        parent.id,
        result,
        scope,
      );
      if (child.state === 'finalized') {
        const next = await this.advanceSourceFundedInScope(scope, parent, child);
        return { parent: next, child };
      }
      if (child.state === 'failed') {
        const next = await this.finishReclaimedSourceInScope(
          scope,
          parent,
          result.observedAt ?? this.now(),
        );
        return { parent: next, child };
      }
      const observedAt = result.observedAt ?? this.now();
      const next = await this.replaceInScope(scope, parent, {
        ...parent,
        retry: {
          attemptCount: 0,
          lastAttemptAt: observedAt,
          lastSuccessfulObservationAt: observedAt,
          nextAttemptAt: observedAt + 1_000,
        },
      });
      return { parent: next, child };
    });

    if (
      outcome.parent.state === 'source_inflight' &&
      outcome.child?.state === 'executing' &&
      outcome.child.parentExecutionPhase === 'melt_authorized'
    ) {
      return this.driveSource(parentId, true);
    }
    if (outcome.parent.state === 'destination_funded') {
      return this.authorizeAndIssueDestination(parentId);
    }
    return outcome.parent;
  }

  private async advanceSourceFunded(
    parent: MintSwapOperation,
    child: FinalizedMeltOperation,
  ): Promise<MintSwapOperation> {
    return this.repositories.withTransaction(async (scope) => {
      const current = await this.requireOperationInScope(scope, parent.id);
      if (current.state !== 'source_inflight') return current;
      const persisted = await scope.meltOperationRepository.getById(child.id);
      if (!persisted || persisted.state !== 'finalized') {
        throw new Error('Canonical finalized source child is missing');
      }
      return this.advanceSourceFundedInScope(scope, current, persisted);
    });
  }

  private async advanceSourceFundedInScope(
    scope: RepositoryTransactionScope,
    parent: MintSwapOperation,
    child: FinalizedMeltOperation,
  ): Promise<MintSwapOperation> {
    const settlement = this.calculateSettlement(parent, child);
    const candidate: MintSwapOperation = {
      ...parent,
      state: 'destination_funded',
      settlement,
      retry: {
        ...parent.retry,
        attemptCount: 0,
        nextAttemptAt: undefined,
        lastError: undefined,
        lastSuccessfulObservationAt: this.now(),
      },
    };
    validateMintSwapAccounting({
      ...candidate,
      revision: parent.revision + 1,
      updatedAt: Math.max(parent.updatedAt, this.now()),
    });
    return this.replaceInScope(scope, parent, candidate, 'mint-swap-op:destination-funded');
  }

  private async finishReclaimedSource(
    parent: MintSwapOperation,
    reclaimedAt: number,
  ): Promise<MintSwapOperation> {
    return this.repositories.withTransaction(async (scope) => {
      const current = await this.requireOperationInScope(scope, parent.id);
      if (current.state !== 'source_inflight') return current;
      return this.finishReclaimedSourceInScope(scope, current, reclaimedAt);
    });
  }

  private finishReclaimedSourceInScope(
    scope: RepositoryTransactionScope,
    parent: MintSwapOperation,
    reclaimedAt: number,
  ): Promise<MintSwapOperation> {
    const cancelled = parent.cancellationRequestedAt !== undefined;
    const at = Math.max(this.now(), reclaimedAt, parent.updatedAt);
    return this.replaceInScope(
      scope,
      parent,
      cancelled
        ? {
            ...parent,
            state: 'cancelled',
            sourceReclaimedAt: reclaimedAt,
            cancelledAt: at,
          }
        : {
            ...parent,
            state: 'failed',
            sourceReclaimedAt: reclaimedAt,
            terminalFailure: {
              code: 'source_unpaid',
              reason: 'Source payment was not completed and its proofs were reclaimed',
              at,
            },
          },
      cancelled ? 'mint-swap-op:cancelled' : 'mint-swap-op:failed',
      cancelled ? undefined : 'source_unpaid',
    );
  }

  private async authorizeAndIssueDestination(operationId: string): Promise<MintSwapOperation> {
    const authorized = await this.repositories.withTransaction(async (scope) => {
      const parent = await this.requireOperationInScope(scope, operationId);
      if (parent.state !== 'destination_funded') return false;
      await this.mintOperationService.authorizeOwnedExecutionInTransaction(
        parent.destinationMintOperationId!,
        parent.id,
        scope,
      );
      const now = this.now();
      await this.replaceInScope(
        scope,
        parent,
        {
          ...parent,
          state: 'issuing',
          destinationIssueAuthorizedAt: now,
          retry: {
            ...parent.retry,
            attemptCount: 0,
            lastError: undefined,
            lastSuccessfulObservationAt: now,
            nextAttemptAt: now + this.leaseDurationMs,
          },
        },
        'mint-swap-op:issuing',
      );
      return true;
    });
    if (!authorized) return this.requireOperation(operationId);
    return this.issueDestination(operationId);
  }

  private async issueDestination(operationId: string): Promise<MintSwapOperation> {
    const parent = await this.requireOperation(operationId);
    if (parent.state !== 'issuing') return parent;
    const child = await this.repositories.mintOperationRepository.getById(
      parent.destinationMintOperationId!,
    );
    if (!child || child.parentSwapOperationId !== parent.id) {
      return this.moveToAttention(
        parent,
        'ownership_conflict',
        'Mint swap destination child ownership no longer matches its parent',
        'destination child ownership',
      );
    }
    if (child.state === 'finalized') return this.completeDestination(parent, child);
    if (child.state !== 'executing') {
      return this.moveToAttention(
        parent,
        'source_paid_destination_terminal',
        'Paid source cannot advance its destination child',
        'destination child progress state',
        { childState: child.state },
      );
    }

    try {
      const result = await this.mintOperationService.executeOwnedRemote(child.id, parent.id);
      if (result.status === 'ALREADY_ISSUED') {
        return this.moveToAttention(
          parent,
          'destination_proofs_unrecoverable',
          'Destination issuance was consumed but deterministic proofs were not recoverable',
          'destination proof restoration',
        );
      }
      if (result.status === 'FAILED') {
        return this.moveToAttention(
          parent,
          'source_paid_destination_terminal',
          'Destination mint rejected issuance after source payment',
          'source-paid destination delivery',
        );
      }
      return this.repositories.withTransaction(async (scope) => {
        const current = await this.requireOperationInScope(scope, parent.id);
        if (current.state !== 'issuing') return current;
        const finalized = await this.mintOperationService.applyOwnedExecutionInTransaction(
          child.id,
          parent.id,
          result,
          scope,
        );
        if (finalized.state !== 'finalized') return current;
        return this.completeDestinationInScope(scope, current, finalized);
      });
    } catch (error) {
      throw error;
    }
  }

  private async completeDestination(
    parent: MintSwapOperation,
    child: FinalizedMintOperation,
  ): Promise<MintSwapOperation> {
    return this.repositories.withTransaction(async (scope) => {
      const current = await this.requireOperationInScope(scope, parent.id);
      if (current.state !== 'issuing') return current;
      return this.completeDestinationInScope(scope, current, child);
    });
  }

  private completeDestinationInScope(
    scope: RepositoryTransactionScope,
    parent: MintSwapOperation,
    child: FinalizedMintOperation,
  ): Promise<MintSwapOperation> {
    if (!parent.settlement || !child.amount.equals(parent.destinationAmount)) {
      return this.moveToAttentionInScope(
        scope,
        parent,
        'accounting_mismatch',
        'Destination issuance amount does not match the exact receive amount',
        'destination exact-receive accounting',
      );
    }
    const completedAt = this.now();
    return this.replaceInScope(
      scope,
      parent,
      {
        ...parent,
        state: 'completed',
        settlement: {
          ...parent.settlement,
          destinationAmountIssued: child.amount,
        },
        completedAt,
        retry: {
          ...parent.retry,
          attemptCount: 0,
          nextAttemptAt: undefined,
          lastError: undefined,
          lastSuccessfulObservationAt: completedAt,
        },
      },
      'mint-swap-op:completed',
    );
  }

  private async buildPreparedPlan(
    parent: MintSwapOperation,
    child: PreparedMeltOperation,
    destinationQuote: MintQuote<'bolt11'>,
    sourceQuote: MeltQuote<'bolt11'>,
    sourceWallet: Wallet,
    requiredDispatchWindowSeconds?: number,
  ): Promise<Omit<MintSwapPreparedPlan, 'fingerprint'>> {
    const inputs = await this.repositories.proofRepository.getProofsBySecrets(
      child.mintUrl,
      child.inputProofSecrets,
    );
    if (inputs.length !== child.inputProofSecrets.length) {
      throw new Error('Prepared source inputs are no longer available');
    }
    const sourcePreparationFee = child.swap_fee;
    const sourceMeltInputFee = this.sourceMeltInputFee(child, inputs, sourceWallet);
    const sourceKeepAmount = this.sourceKeepAmount(child);
    const minimumSourceDebit = child.amount.add(sourcePreparationFee).add(sourceMeltInputFee);
    const maximumSourceDebit = child.needsSwap
      ? child.inputAmount.subtract(sourceKeepAmount)
      : child.inputAmount;
    if (maximumSourceDebit.greaterThan(child.inputAmount)) {
      throw new Error('Prepared source plan does not reserve its maximum debit');
    }
    const dispatch = evaluateMintSwapDispatchWindow({
      expiries: [destinationQuote.expiry, sourceQuote.expiry],
      now: Math.floor(this.now() / 1_000),
      requiredWindowSeconds: requiredDispatchWindowSeconds,
    });
    if (!dispatch.canDispatch) throw new Error('Mint swap quote expiry window is too short');
    return {
      dispatchDeadlineSeconds: dispatch.dispatchDeadlineSeconds,
      requiredDispatchWindowSeconds: dispatch.requiredWindowSeconds,
      sourceMeltAmount: child.amount,
      sourceFeeReserve: child.fee_reserve,
      sourcePreparationFee,
      sourceMeltInputFee,
      minimumSourceDebit,
      maximumSourceDebit,
      reservedSourceAmount: child.inputAmount,
    };
  }

  private calculateSettlement(
    parent: MintSwapOperation,
    child: FinalizedMeltOperation,
  ): MintSwapSettlement {
    const plan = parent.preparedPlan!;
    if (child.effectiveFee === undefined) {
      throw new Error('Finalized source child is missing canonical settlement amounts');
    }
    if (child.effectiveFee.lessThan(plan.sourceMeltInputFee)) {
      throw new Error('Source effective fee is below its persisted melt input fee');
    }
    const sourcePaymentFee = child.effectiveFee.subtract(plan.sourceMeltInputFee);
    const totalSourceFee = plan.sourcePreparationFee
      .add(plan.sourceMeltInputFee)
      .add(sourcePaymentFee);
    const sourceMeltChangeAmount = child.changeAmount ?? Amount.zero();
    const sourceKeepAmount = this.sourceKeepAmount(child);
    const sourceReturnedAmount = sourceKeepAmount.add(sourceMeltChangeAmount);
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

  private sourceMeltInputFee(
    child: PreparedMeltOperation,
    inputs: Proof[],
    wallet: Wallet,
  ): Amount {
    if (!child.needsSwap) return wallet.getFeesForProofs(inputs);
    if (!child.swapOutputData) throw new Error('Source pre-swap output plan is missing');
    return this.sumOutputs(child.swapOutputData.send)
      .subtract(child.amount)
      .subtract(child.fee_reserve);
  }

  private sourceKeepAmount(child: PreparedMeltOperation | FinalizedMeltOperation): Amount {
    return child.swapOutputData ? this.sumOutputs(child.swapOutputData.keep) : Amount.zero();
  }

  private async assertPreparedPlan(operation: MintSwapOperation): Promise<void> {
    const [destinationChild, sourceChild] = await Promise.all([
      this.repositories.mintOperationRepository.getById(operation.destinationMintOperationId!),
      this.repositories.meltOperationRepository.getById(operation.sourceMeltOperationId!),
    ]);
    if (
      !destinationChild ||
      destinationChild.parentSwapOperationId !== operation.id ||
      !sourceChild ||
      sourceChild.parentSwapOperationId !== operation.id
    ) {
      throw new Error('Mint swap child ownership no longer matches the prepared plan');
    }
    if (!('outputData' in destinationChild) || !('inputProofSecrets' in sourceChild)) {
      throw new Error('Mint swap child recovery material is incomplete');
    }
    const plan = operation.preparedPlan!;
    const fingerprint = createMintSwapPreparedPlanFingerprint({
      destinationMintOperationId: destinationChild.id,
      sourceMeltOperationId: sourceChild.id,
      destinationQuoteRef: operation.destinationQuoteRef!,
      sourceQuoteRef: operation.sourceQuoteRef!,
      destinationNut20Key: operation.destinationNut20Key,
      destinationAmount: operation.destinationAmount,
      unit: 'sat',
      sourceInputProofSecrets: sourceChild.inputProofSecrets,
      destinationOutputData: destinationChild.outputData,
      sourceOutputData: this.sourceOutputData(sourceChild),
      sourceMeltAmount: plan.sourceMeltAmount,
      sourceFeeReserve: plan.sourceFeeReserve,
      sourcePreparationFee: plan.sourcePreparationFee,
      sourceMeltInputFee: plan.sourceMeltInputFee,
      minimumSourceDebit: plan.minimumSourceDebit,
      maximumSourceDebit: plan.maximumSourceDebit,
      reservedSourceAmount: plan.reservedSourceAmount,
      dispatchDeadlineSeconds: plan.dispatchDeadlineSeconds,
      requiredDispatchWindowSeconds: plan.requiredDispatchWindowSeconds,
    });
    if (fingerprint !== plan.fingerprint) {
      throw new Error('Mint swap child data no longer matches the prepared plan');
    }
  }

  private assertDispatchWindow(operation: MintSwapOperation): void {
    const plan = operation.preparedPlan!;
    const remaining = plan.dispatchDeadlineSeconds - Math.floor(this.now() / 1_000);
    if (remaining < plan.requiredDispatchWindowSeconds) {
      throw new Error('Mint swap dispatch safety window has elapsed');
    }
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
      this.mintService.assertNutSupported(destinationMintUrl, 20, 'mint swap destination claim'),
    ]);
  }

  private assertDestinationQuote(
    quote: MintQuote,
    operation: MintSwapOperation,
  ): asserts quote is MintQuote<'bolt11'> {
    const amount = getMintQuoteAmount(quote);
    if (
      quote.method !== 'bolt11' ||
      quote.mintUrl !== operation.destinationMintUrl ||
      quote.unit !== 'sat' ||
      !amount?.equals(operation.destinationAmount) ||
      quote.pubkey !== operation.destinationNut20Key.publicKey
    ) {
      throw new Error('Destination quote does not match the locked mint swap intent');
    }
  }

  private assertSourceQuote(
    quote: MeltQuote,
    destinationQuote: MintQuote<'bolt11'>,
    operation: MintSwapOperation,
  ): asserts quote is MeltQuote<'bolt11'> {
    if (
      quote.method !== 'bolt11' ||
      quote.mintUrl !== operation.sourceMintUrl ||
      quote.unit !== 'sat' ||
      !quote.amount.equals(operation.destinationAmount) ||
      quote.request !== destinationQuote.request
    ) {
      throw new Error('Source quote does not pay the locked destination invoice exactly');
    }
  }

  private async requireDestinationQuote(
    operation: MintSwapOperation,
  ): Promise<MintQuote<'bolt11'>> {
    const ref = operation.destinationQuoteRef!;
    const quote = await this.quoteLifecycle.getMintQuote(ref.mintUrl, ref.method, ref.quoteId);
    if (!quote) throw new Error('Mint swap destination quote is missing');
    this.assertDestinationQuote(quote, operation);
    return quote;
  }

  private async requireSourceQuote(operation: MintSwapOperation): Promise<MeltQuote<'bolt11'>> {
    const ref = operation.sourceQuoteRef!;
    const quote = await this.quoteLifecycle.getMeltQuote(ref.mintUrl, ref.method, ref.quoteId);
    if (!quote) throw new Error('Mint swap source quote is missing');
    const destinationQuote = await this.requireDestinationQuote(operation);
    this.assertSourceQuote(quote, destinationQuote, operation);
    return quote;
  }

  private async moveToAttention(
    operation: MintSwapOperation,
    reason: MintSwapAttentionReason,
    message: string,
    violatedInvariant: string,
    evidence: Record<string, string | number | boolean | null> = {},
  ): Promise<MintSwapOperation> {
    return this.repositories.withTransaction(async (scope) => {
      const current = await this.requireOperationInScope(scope, operation.id);
      if (current.state === 'needs_attention' || isTerminalMintSwapState(current.state)) {
        return current;
      }
      return this.moveToAttentionInScope(
        scope,
        current,
        reason,
        message,
        violatedInvariant,
        evidence,
      );
    });
  }

  private moveToAttentionInScope(
    scope: RepositoryTransactionScope,
    operation: MintSwapOperation,
    reason: MintSwapAttentionReason,
    message: string,
    violatedInvariant: string,
    evidence: Record<string, string | number | boolean | null> = {},
  ): Promise<MintSwapOperation> {
    const at = this.now();
    return this.replaceInScope(
      scope,
      operation,
      {
        ...operation,
        state: 'needs_attention',
        preparationLease: undefined,
        attention: {
          reason,
          message,
          lastSafeState: operation.state,
          violatedInvariant,
          evidence,
          at,
        },
      },
      'mint-swap-op:needs-attention',
      reason,
    );
  }

  private async failPreparation(operationId: string, error: unknown): Promise<void> {
    try {
      await this.repositories.withTransaction(async (scope) => {
        const operation = await this.requireOperationInScope(scope, operationId);
        if (operation.state !== 'preparing') return;
        const at = this.now();
        await this.replaceInScope(
          scope,
          operation,
          {
            ...operation,
            state: 'failed',
            preparationLease: undefined,
            terminalFailure: {
              code: 'preparation_failed',
              reason: 'Mint swap preparation could not be completed',
              at,
            },
          },
          'mint-swap-op:failed',
          'preparation_failed',
        );
      });
    } catch (recoveryError) {
      this.logger?.warn('Mint swap preparation cleanup failed', {
        operationId,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      });
    }
    this.logger?.warn('Mint swap preparation failed', {
      operationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private failPreparedBeforeDispatch(operation: MintSwapOperation): Promise<MintSwapOperation> {
    return this.repositories.withTransaction(async (scope) => {
      const current = await this.requireOperationInScope(scope, operation.id);
      if (current.state !== 'prepared') return current;
      await this.meltOperationService.rollbackOwnedPreparedInTransaction(
        current.sourceMeltOperationId!,
        current.id,
        scope,
        'Mint swap dispatch safety window elapsed',
      );
      const at = this.now();
      return this.replaceInScope(
        scope,
        current,
        {
          ...current,
          state: 'failed',
          terminalFailure: {
            code: 'dispatch_window_elapsed',
            reason: 'Mint swap dispatch safety window elapsed before source authorization',
            at,
          },
        },
        'mint-swap-op:failed',
        'dispatch_window_elapsed',
      );
    });
  }

  async recordProcessorFailure(operationId: string, nextAttemptAt: number): Promise<boolean> {
    return this.repositories.withTransaction(async (scope) => {
      const operation = await this.requireOperationInScope(scope, operationId);
      if (!isAutomaticMintSwapState(operation.state)) return false;
      const now = this.now();
      const attemptCount = operation.retry.attemptCount + 1;
      await this.replaceInScope(
        scope,
        operation,
        {
          ...operation,
          retry: {
            ...operation.retry,
            attemptCount,
            lastAttemptAt: now,
            nextAttemptAt: Math.max(now, nextAttemptAt),
            lastError: 'Mint swap reconciliation failed; retry is scheduled',
          },
        },
        'mint-swap-op:delayed',
        'retry_scheduled',
      );
      return true;
    });
  }

  async recordProcessorSuccess(operationId: string): Promise<boolean> {
    return this.repositories.withTransaction(async (scope) => {
      const operation = await this.requireOperationInScope(scope, operationId);
      if (!isAutomaticMintSwapState(operation.state) || !operation.retry.lastError) return false;
      await this.replaceInScope(scope, operation, {
        ...operation,
        retry: {
          ...operation.retry,
          attemptCount: 0,
          lastError: undefined,
          lastSuccessfulObservationAt: this.now(),
        },
      });
      return true;
    });
  }

  private async replaceInScope(
    scope: RepositoryTransactionScope,
    current: MintSwapOperation,
    candidate: MintSwapOperation,
    eventType?: MintSwapEventType,
    reasonCode?: string,
  ): Promise<MintSwapOperation> {
    const now = Math.max(
      current.updatedAt,
      this.now(),
      candidate.retry.lastAttemptAt ?? 0,
      candidate.retry.lastSuccessfulObservationAt ?? 0,
      candidate.sourceDispatchAuthorizedAt ?? 0,
      candidate.sourceReclaimedAt ?? 0,
      candidate.destinationIssueAuthorizedAt ?? 0,
      candidate.cancellationRequestedAt ?? 0,
      candidate.cancelledAt ?? 0,
      candidate.completedAt ?? 0,
      candidate.attention?.at ?? 0,
      candidate.terminalFailure?.at ?? 0,
    );
    const next: MintSwapOperation = {
      ...candidate,
      revision: current.revision + 1,
      updatedAt: now,
    };
    const repository = requireMintSwapRepositoryCapability(scope).mintSwapOperationRepository;
    if (!(await repository.compareAndSet(next, current.revision))) {
      throw new MintSwapCasError(`Mint swap ${current.id} lost revision ${current.revision}`);
    }
    if (eventType) {
      await requireMintSwapRepositoryCapability(scope).operationEventOutboxRepository.enqueue(
        this.outbox(next, eventType, reasonCode),
      );
    }
    return next;
  }

  private outbox(
    operation: MintSwapOperation,
    eventType: MintSwapEventType,
    reasonCode?: string,
  ): OperationEventOutboxRecord {
    return {
      id: `${operation.id}:${operation.revision}:${eventType}`,
      operationId: operation.id,
      revision: operation.revision,
      eventType,
      payload: {
        operationId: operation.id,
        revision: operation.revision,
        state: operation.state,
        sourceMintUrl: operation.sourceMintUrl,
        destinationMintUrl: operation.destinationMintUrl,
        unit: 'sat',
        destinationAmount: operation.destinationAmount.toString(),
        reasonCode,
      },
      createdAt: operation.updatedAt,
      publishAttempts: 0,
    };
  }

  private async requirePreparingLeaseInScope(
    scope: RepositoryTransactionScope,
    operationId: string,
    expected: MintSwapPreparationLease,
  ): Promise<MintSwapOperation> {
    const current = await this.requireOperationInScope(scope, operationId);
    assertMintSwapPreparationLeaseOwner(current, expected.ownerId, expected.token, this.now());
    if (current.preparationLease?.stage !== expected.stage) {
      throw new MintSwapCasError(`Mint swap ${operationId} preparation stage changed`);
    }
    return current;
  }

  private newLease(
    stage: MintSwapPreparationLease['stage'],
    now: number,
  ): MintSwapPreparationLease {
    return {
      ownerId: this.workerId,
      token: this.generateId(),
      stage,
      acquiredAt: now,
      expiresAt: now + this.leaseDurationMs,
    };
  }

  private advanceLease(
    lease: MintSwapPreparationLease,
    stage: MintSwapPreparationLease['stage'],
  ): MintSwapPreparationLease {
    return {
      ...lease,
      stage,
      expiresAt: Math.max(lease.expiresAt, this.now() + this.leaseDurationMs),
    };
  }

  private quoteRef(quote: MintQuote<'bolt11'> | MeltQuote<'bolt11'>) {
    return { mintUrl: quote.mintUrl, method: 'bolt11' as const, quoteId: quote.quoteId };
  }

  private childId(parentId: string, role: 'source' | 'destination'): string {
    return `${parentId}:${role}`;
  }

  private sumOutputs(outputs: Array<{ blindedMessage: { amount: string | number } }>): Amount {
    return outputs.reduce(
      (total, output) => total.add(Amount.from(output.blindedMessage.amount)),
      Amount.zero(),
    );
  }

  private sourceOutputData(
    child: Pick<PreparedMeltOperation, 'changeOutputData' | 'swapOutputData'>,
  ) {
    return child.swapOutputData
      ? { change: child.changeOutputData, swap: child.swapOutputData }
      : { change: child.changeOutputData };
  }

  private parentRepository() {
    return requireMintSwapRepositoryCapability(this.repositories).mintSwapOperationRepository;
  }

  private async requireOperation(operationId: string): Promise<MintSwapOperation> {
    const operation = await this.parentRepository().getById(operationId);
    if (!operation) throw new Error(`Mint swap ${operationId} was not found`);
    return operation;
  }

  private async requireOperationInScope(
    scope: RepositoryTransactionScope,
    operationId: string,
  ): Promise<MintSwapOperation> {
    const operation =
      await requireMintSwapRepositoryCapability(scope).mintSwapOperationRepository.getById(
        operationId,
      );
    if (!operation) throw new Error(`Mint swap ${operationId} was not found`);
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
    const operations = (
      await Promise.all(states.map((state) => this.parentRepository().getByState(state)))
    ).flat();
    return operations.sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
  }
}
