import { Amount, RateLimitError, type Proof } from '@cashu/cashu-ts';
import type { CoreTransaction, CoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import type { MintSwapOperationRepository } from './MintSwapOperationRepository.ts';
import type {
  MeltOperationRepository,
  MintOperationRepository,
  ProofRepository,
} from '../../repositories/index.ts';
import type { MintService } from '../../services/MintService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import type { KeyRingService } from '../../services/KeyRingService.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import type { MintHandlerProvider } from '../../infra/handlers/mint/MintHandlerProvider.ts';
import type { MeltHandlerProvider } from '../../infra/handlers/melt/MeltHandlerProvider.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { MintSwapOperation } from './MintSwapOperation.ts';
import { isMintSwapAutomaticState, isMintSwapTerminalState } from './MintSwapOperation.ts';
import { OperationIdLock } from '../OperationIdLock.ts';
import type { MintScopedLock } from '../MintScopedLock.ts';
import { createKeyChain } from '../../proofs/KeysetSelection.ts';
import { generateSubId, getSecretsFromSerializedOutputData } from '../../utils.ts';
import {
  OperationInProgressError,
  ProofValidationError,
  UnknownMintError,
} from '../../models/Error.ts';
import { restoreOutputProofs } from '../../infra/ProofRestore.ts';
import { unblindMeltChange } from '../melt/MeltChange.ts';
import type {
  ExecutingMeltOperation,
  PendingMeltOperation,
  MeltOperation,
} from '../melt/MeltOperation.ts';
import type { ExecutingMintOperation, MintOperation } from '../mint/MintOperation.ts';
import type { MeltQuote } from '../../models/MeltQuote.ts';
import type { CoreProof } from '../../types.ts';
import type { Counter } from '../../models/Counter.ts';
import {
  assertMintSwapIntent,
  initialMintSwapRetry,
  invoiceHash,
  MintSwapInvariantError,
  normalizeMintSwapIntent,
  type MintSwapIntent,
} from './MintSwapValidation.ts';
import { MintSwapDebitCapError } from './MintSwapDebitCapError.ts';
import { MintSwapIdentityConflictError } from './MintSwapIdentityConflictError.ts';
import {
  createMintSwap,
  prepareMintSwap,
  beginMintSwapSource,
  applyMintSwapPreSwap,
  applyMintSwapSource,
  beginMintSwapDestination,
  applyMintSwapDestination,
  cancelMintSwap,
  reconcileMintSwap,
  deferMintSwap,
  flagMintSwapAttention,
} from './MintSwapTransitions.ts';

interface ChildSnapshot {
  source: MeltOperation | null;
  destination: MintOperation | null;
  proofs: CoreProof[];
  counters: Counter[];
}

export interface MintSwapOperationServiceDependencies {
  transactionRunner: CoreTransactionRunner;
  parentQueries: Pick<MintSwapOperationRepository, 'getById' | 'listActive' | 'listDue'>;
  sourceQueries: Pick<MeltOperationRepository, 'getById'>;
  destinationQueries: Pick<MintOperationRepository, 'getById' | 'getByQuoteId'>;
  proofQueries: Pick<ProofRepository, 'getProofsBySecrets'>;
  mintService: Pick<MintService, 'refreshAndCommitIfStale' | 'isTrustedMint'>;
  walletService: Pick<WalletService, 'getWalletWithActiveKeysetId'>;
  keyRingService: Pick<KeyRingService, 'allocateAndCommitMintQuoteKeyPair'>;
  quoteLifecycle: Pick<
    QuoteLifecycle,
    | 'createMintQuote'
    | 'createMeltQuote'
    | 'getMeltQuote'
    | 'refreshMeltQuote'
    | 'refreshMintQuote'
    | 'recordMeltQuoteObservation'
    | 'recordMintQuoteSnapshot'
  >;
  mintHandlerProvider: MintHandlerProvider;
  meltHandlerProvider: MeltHandlerProvider;
  mintAdapter: MintAdapter;
  loadSeed(): Promise<Uint8Array>;
  /** Same instances must be injected into ordinary child services in the effect-driving session. */
  sourceOperationLock: OperationIdLock;
  destinationOperationLock: OperationIdLock;
  mintScopedLock: MintScopedLock;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
  now?: () => number;
  random?: () => number;
}

/**
 * Dormant internal coordinator. Requires one effect-driving Coco Session per Wallet store.
 * Child locks are shared with standalone processors; durable guards make local writes atomic,
 * but do not fence remote effects across independently running sessions. Runtime activation is #419.
 */
export class MintSwapOperationService {
  private readonly parentLock = new OperationIdLock();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly committedChanges = new Map<
    string,
    Array<{ before: ChildSnapshot; after: ChildSnapshot }>
  >();

  constructor(private readonly dependencies: MintSwapOperationServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
  }

  async prepare(request: MintSwapIntent): Promise<MintSwapOperation> {
    const intent = normalizeMintSwapIntent(request);
    return this.withParent(intent.id, async () => {
      let parent = await this.dependencies.parentQueries.getById(intent.id);
      if (parent) assertMintSwapIntent(parent, intent);
      else {
        // Fail before independent key/quote creation on a store without the opt-in capability.
        await this.dependencies.transactionRunner.run(async (tx) => {
          if (!tx.mintSwapOperations) throw new Error('Mint Swap persistence is not enabled');
        });
        await this.preflight(intent);
        await this.dependencies.transactionRunner.run(async (tx) => {
          await tx.mintMetadata.assertCanMint(
            intent.destinationMintUrl,
            'bolt11',
            'sat',
            intent.destinationAmount,
          );
          await tx.mintMetadata.assertCanMelt(intent.sourceMintUrl, 'bolt11', 'sat');
          await tx.mintMetadata.assertSupports(intent.destinationMintUrl, [9, 20]);
        });
        const key = await this.dependencies.keyRingService.allocateAndCommitMintQuoteKeyPair();
        const destination = await this.dependencies.quoteLifecycle.createMintQuote(
          intent.destinationMintUrl,
          'bolt11',
          {
            amount: { amount: intent.destinationAmount, unit: 'sat' },
            locked: true,
            ownedPubkey: key.publicKeyHex,
          },
        );
        if (destination.pubkey !== key.publicKeyHex)
          throw new MintSwapInvariantError('quote_identity', 'quote_conflict', 'destination');
        const source = await this.dependencies.quoteLifecycle.createMeltQuote(
          intent.sourceMintUrl,
          'bolt11',
          { invoice: destination.request },
          'sat',
        );
        const now = this.now();
        const candidate = {
          ...intent,
          schemaVersion: 1 as const,
          state: 'preparing' as const,
          revision: 0,
          unit: 'sat' as const,
          sourceQuote: {
            mintUrl: intent.sourceMintUrl,
            method: 'bolt11' as const,
            quoteId: source.quoteId,
          },
          destinationQuote: {
            mintUrl: intent.destinationMintUrl,
            method: 'bolt11' as const,
            quoteId: destination.quoteId,
          },
          sourceOperationId: generateSubId(),
          destinationOperationId: generateSubId(),
          paymentRequestHash: invoiceHash(destination.request),
          createdAt: now,
          updatedAt: now,
          stateEnteredAt: now,
          retry: initialMintSwapRetry('preparing', now),
        };
        try {
          parent = await this.dependencies.transactionRunner.run((tx) =>
            tx.perform(createMintSwap, candidate),
          );
        } catch (error) {
          if (!(error instanceof MintSwapIdentityConflictError) || error.kind !== 'parent')
            throw error;
          parent = await this.requireParent(intent.id);
          assertMintSwapIntent(parent, intent);
        }
      }
      return this.prepareParent(parent);
    });
  }

  /** Only this explicit entry point may authorize an unpaid prepared source. */
  async execute(id: string): Promise<MintSwapOperation> {
    return this.withParent(id, async () => {
      let parent = await this.requireParent(id);
      if (parent.state === 'preparing') parent = await this.prepareParent(parent);
      if (parent.state !== 'prepared') return this.recoverParent(parent);
      const release = await this.dependencies.sourceOperationLock.acquire(parent.sourceOperationId);
      try {
        const keys = await this.preflight(parent);
        const now = this.now();
        const authorization = await this.commit(id, (tx) =>
          tx.perform(beginMintSwapSource, { id, ...keys, now }),
        );
        if (authorization.changed && authorization.source) {
          await this.dispatchSource(
            authorization.operation,
            authorization.source,
            authorization.inputProofs,
          );
        }
      } catch (error) {
        await this.handleError(id, error, true);
      } finally {
        release();
      }
      return this.recoverDestination(await this.requireParent(id));
    });
  }

  async cancel(id: string): Promise<MintSwapOperation> {
    return this.withParent(id, async () => {
      const parent = await this.requireParent(id);
      const release = await this.dependencies.sourceOperationLock.acquire(parent.sourceOperationId);
      try {
        const now = this.now();
        const result = await this.commit(id, (tx) => tx.perform(cancelMintSwap, { id, now }));

        return result;
      } finally {
        release();
      }
    });
  }

  async reconcile(id: string): Promise<MintSwapOperation> {
    return this.withParent(id, async () => this.recoverParent(await this.requireParent(id)));
  }

  /** Startup scans include prepared parents so independently advanced children are adopted. */
  async recoverActive(): Promise<void> {
    for (const parent of await this.dependencies.parentQueries.listActive()) {
      if (parent.state === 'needs_attention') continue;
      try {
        await this.reconcile(parent.id);
      } catch (error) {
        // Shared child services can own this attempt; leave it for the next scan.
        if (!(error instanceof OperationInProgressError)) throw error;
      }
    }
  }

  async recoverDue(limit = 25): Promise<void> {
    const dueAt = this.now();
    for (const candidate of await this.dependencies.parentQueries.listDue(dueAt, limit)) {
      try {
        await this.withParent(candidate.id, async () => {
          const current = await this.requireParent(candidate.id);
          if (
            !isMintSwapAutomaticState(current.state) ||
            current.retry.nextAttemptAt === null ||
            current.retry.nextAttemptAt > dueAt
          )
            return;
          await this.recoverParent(current);
        });
      } catch (error) {
        if (!(error instanceof OperationInProgressError)) throw error;
      }
    }
  }

  private async prepareParent(parent: MintSwapOperation): Promise<MintSwapOperation> {
    if (parent.state !== 'preparing') return parent;
    if (parent.cancellationRequestedAt !== undefined) {
      const now = this.now();
      return this.commit(parent.id, (tx) => tx.perform(cancelMintSwap, { id: parent.id, now }));
    }
    const releases: Array<() => void> = [];
    try {
      releases.push(await this.dependencies.sourceOperationLock.acquire(parent.sourceOperationId));
      releases.push(
        await this.dependencies.destinationOperationLock.acquire(parent.destinationOperationId),
      );
      const observedAt = this.now();
      parent = await this.commit(parent.id, (tx) =>
        tx.perform(reconcileMintSwap, { id: parent.id, now: observedAt }),
      );
      if (parent.state !== 'preparing') return parent;
      for (const url of [parent.sourceMintUrl, parent.destinationMintUrl].sort())
        releases.push(await this.dependencies.mintScopedLock.acquire(url));
      const keys = await this.preflight(parent);
      const seed = await this.dependencies.loadSeed();
      const now = this.now();
      const result = await this.commit(parent.id, (tx) =>
        tx.perform(prepareMintSwap, { id: parent.id, ...keys, seed, now }),
      );

      return result;
    } catch (error) {
      return this.handleError(parent.id, error, true);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private async preflight(parent: MintSwapIntent) {
    const source = await this.dependencies.mintService.refreshAndCommitIfStale(
      parent.sourceMintUrl,
    );
    const destination = await this.dependencies.mintService.refreshAndCommitIfStale(
      parent.destinationMintUrl,
    );
    if (
      ![source, destination].every((metadata) =>
        metadata.keysets.some((keyset) => keyset.active && keyset.unit === 'sat'),
      )
    )
      throw new ProofValidationError('Mint Swap active keys are unavailable');
    const sourceKeys = createKeyChain(parent.sourceMintUrl, 'sat', source.keysets)
      .getCheapestKeyset()
      .toMintKeys();
    const destinationKeys = createKeyChain(parent.destinationMintUrl, 'sat', destination.keysets)
      .getCheapestKeyset()
      .toMintKeys();
    if (!sourceKeys || !destinationKeys)
      throw new ProofValidationError('Mint Swap active keys are unavailable');
    return { sourceKeys, destinationKeys };
  }

  private async dispatchSource(
    parent: MintSwapOperation,
    operation: ExecutingMeltOperation,
    inputProofs: CoreProof[],
  ) {
    const handler = this.dependencies.meltHandlerProvider.get('bolt11');
    const source = operation as ExecutingMeltOperation & {
      method: 'bolt11';
      methodData: { invoice: string };
    };
    let inputs: Proof[] = inputProofs;
    if (source.needsSwap) {
      const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
        source.mintUrl,
        source.unit,
      );
      const result = await handler.swap({
        operation: source,
        wallet,
        inputProofs: inputs,
        logger: this.dependencies.logger,
      });
      const now = this.now();
      const checkpoint = await this.commit(parent.id, (tx) =>
        tx.perform(applyMintSwapPreSwap, {
          id: parent.id,
          result: { operation: source, keepProofs: result.keep, sendProofs: result.send, now },
        }),
      );
      if (checkpoint.state !== 'source_pending') return;
      inputs = await this.dependencies.proofQueries.getProofsBySecrets(
        source.mintUrl,
        result.send.map((proof) => proof.secret),
      );
      if (inputs.length !== result.send.length)
        throw new MintSwapInvariantError('recovery_material', 'proofs_missing', 'source');
    }
    if (!(await this.dependencies.mintService.isTrustedMint(source.mintUrl)))
      throw new UnknownMintError('Mint Swap source is no longer trusted');
    const result = await handler.melt({
      operation: source,
      inputProofs: inputs,
      mintAdapter: this.dependencies.mintAdapter,
      logger: this.dependencies.logger,
    });
    const existing = await this.dependencies.quoteLifecycle.getMeltQuote(
      source.mintUrl,
      'bolt11',
      source.quoteId,
    );
    if (!existing || existing.method !== 'bolt11')
      throw new MintSwapInvariantError('quote_identity', 'quote_missing', 'source');
    const now = this.now();
    const quote = await this.dependencies.quoteLifecycle.recordMeltQuoteObservation({
      ...existing,
      state: result.status,
      change: result.change,
      payment_preimage: result.finalizedData?.preimage,
      lastObservedRemoteState: result.status,
      lastObservedRemoteStateAt: now,
      updatedAt: now,
    });
    await this.applySourceObservation(parent, operation, quote, false);
  }

  private async recoverParent(parent: MintSwapOperation): Promise<MintSwapOperation> {
    const startingState = parent.state;
    const startingRetryCount = parent.retry.attemptCount;
    if (isMintSwapTerminalState(parent.state) || parent.state === 'needs_attention') return parent;
    if (parent.state === 'preparing') return this.prepareParent(parent);
    const release = await this.dependencies.sourceOperationLock.acquire(parent.sourceOperationId);
    try {
      const now = this.now();
      parent = await this.commit(parent.id, (tx) =>
        tx.perform(reconcileMintSwap, { id: parent.id, now }),
      );
      if (parent.state === 'prepared' || parent.state === 'source_pending') {
        const source = await this.dependencies.sourceQueries.getById(parent.sourceOperationId);
        if (source?.state === 'rolled_back') {
          if (!(await this.dependencies.mintService.isTrustedMint(parent.sourceMintUrl)))
            throw new UnknownMintError('Mint Swap source is no longer trusted');
          await this.dependencies.quoteLifecycle.refreshMeltQuote(
            parent.sourceMintUrl,
            'bolt11',
            parent.sourceQuote.quoteId,
          );
          const observedAt = this.now();
          parent = await this.commit(parent.id, (tx) =>
            tx.perform(reconcileMintSwap, { id: parent.id, now: observedAt }),
          );
        }
      }
      if (parent.state === 'source_pending') {
        if (!(await this.dependencies.mintService.isTrustedMint(parent.sourceMintUrl)))
          throw new UnknownMintError('Mint Swap source is no longer trusted');
        const source = await this.dependencies.sourceQueries.getById(parent.sourceOperationId);
        if (source?.state === 'executing' || source?.state === 'pending') {
          const quote = await this.dependencies.quoteLifecycle.refreshMeltQuote(
            parent.sourceMintUrl,
            'bolt11',
            parent.sourceQuote.quoteId,
          );
          const originalsUnspent =
            source.needsSwap && source.state === 'executing'
              ? await this.recoverPreSwap(parent, source, quote)
              : false;
          await this.applySourceObservation(parent, source, quote, originalsUnspent);
        }
      }
    } catch (error) {
      await this.handleError(parent.id, error);
    } finally {
      release();
    }
    parent = await this.recoverDestination(await this.requireParent(parent.id));
    const alreadyScheduled =
      parent.state === startingState
        ? parent.retry.attemptCount > startingRetryCount
        : parent.retry.attemptCount > 0;
    if (isMintSwapAutomaticState(parent.state) && !alreadyScheduled) return this.defer(parent);
    return parent;
  }

  private async recoverPreSwap(
    parent: MintSwapOperation,
    operation: ExecutingMeltOperation,
    quote: MeltQuote,
  ): Promise<boolean> {
    if (!operation.swapOutputData)
      throw new MintSwapInvariantError('recovery_material', 'outputs_missing', 'source');
    const { keepSecrets, sendSecrets } = getSecretsFromSerializedOutputData(
      operation.swapOutputData,
    );
    const secrets = [...keepSecrets, ...sendSecrets];
    const stored = await this.dependencies.proofQueries.getProofsBySecrets(
      operation.mintUrl,
      secrets,
    );
    if (stored.length === secrets.length) return false;
    if (stored.length) throw new Error('Pre-swap restoration is incomplete');
    const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
      operation.mintUrl,
      operation.unit,
    );
    const originals = await this.dependencies.proofQueries.getProofsBySecrets(
      operation.mintUrl,
      operation.inputProofSecrets,
    );
    if (originals.length !== operation.inputProofSecrets.length)
      throw new MintSwapInvariantError('recovery_material', 'proofs_missing', 'source');
    const states = await wallet.checkProofsStates(originals);
    if (states.length === originals.length && states.every((state) => state.state === 'UNSPENT')) {
      if (quote.state !== 'UNPAID')
        throw new MintSwapInvariantError('source_settlement', 'settlement_mismatch', 'source');
      return true;
    }
    const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(operation.mintUrl);
    const restored = await restoreOutputProofs(
      wallet,
      metadata.keysets,
      operation.unit,
      operation.swapOutputData,
    );
    const keep = restored.filter((proof) => keepSecrets.includes(proof.secret));
    const send = restored.filter((proof) => sendSecrets.includes(proof.secret));
    if (keep.length !== keepSecrets.length || send.length !== sendSecrets.length)
      throw new Error('Pre-swap restoration is incomplete');
    const now = this.now();
    await this.commit(parent.id, (tx) =>
      tx.perform(applyMintSwapPreSwap, {
        id: parent.id,
        result: { operation, keepProofs: keep, sendProofs: send, now },
      }),
    );
    return false;
  }

  private async applySourceObservation(
    parent: MintSwapOperation,
    operation: ExecutingMeltOperation | PendingMeltOperation,
    quote: MeltQuote,
    originalProofsUnspent: boolean,
  ) {
    let changeProofs: Proof[] | undefined;
    if (quote.state === 'PAID') {
      if (!Array.isArray(quote.change)) throw new Error('Source settlement change is incomplete');
      const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(
        operation.mintUrl,
      );
      changeProofs = unblindMeltChange(operation, quote.change, metadata.keysets);
    }
    const now = this.now();
    const result = await this.commit(parent.id, (tx) =>
      tx.perform(applyMintSwapSource, {
        id: parent.id,
        now,
        ...(changeProofs
          ? {
              paid: {
                operation,
                changeProofs,
                now,
                finalizedData:
                  quote.method === 'bolt11' && quote.payment_preimage
                    ? { preimage: quote.payment_preimage }
                    : undefined,
              },
            }
          : {}),
        ...(quote.state === 'UNPAID' && quote.lastObservedRemoteStateAt !== undefined
          ? {
              nonPayment: {
                kind: 'quote-observation-unpaid' as const,
                mintUrl: operation.mintUrl,
                method: operation.method,
                quoteId: operation.quoteId,
                observedAt: quote.lastObservedRemoteStateAt,
                originalProofsUnspent,
              },
            }
          : {}),
      }),
    );

    return result;
  }

  private async recoverDestination(parent: MintSwapOperation): Promise<MintSwapOperation> {
    if (parent.state !== 'destination_funded' && parent.state !== 'destination_pending')
      return parent;
    const release = await this.dependencies.destinationOperationLock.acquire(
      parent.destinationOperationId,
    );
    try {
      if (!(await this.dependencies.mintService.isTrustedMint(parent.destinationMintUrl)))
        throw new UnknownMintError('Mint Swap destination is no longer trusted');
      await this.dependencies.quoteLifecycle.refreshMintQuote(
        parent.destinationMintUrl,
        'bolt11',
        parent.destinationQuote.quoteId,
      );
      let now = this.now();
      parent = await this.commit(parent.id, (tx) =>
        tx.perform(reconcileMintSwap, { id: parent.id, now }),
      );
      if (parent.state === 'completed' || parent.state === 'needs_attention') return parent;
      let newlyAuthorized = false;
      if (parent.state === 'destination_funded') {
        now = this.now();
        const result = await this.commit(parent.id, (tx) =>
          tx.perform(beginMintSwapDestination, { id: parent.id, now }),
        );
        parent = result.operation;
        newlyAuthorized = result.changed;
      }
      const child = await this.dependencies.destinationQueries.getById(
        parent.destinationOperationId,
      );
      if (parent.state !== 'destination_pending' || child?.state !== 'executing') return parent;
      const operation = child as ExecutingMintOperation<'bolt11'>;
      const handler = this.dependencies.mintHandlerProvider.get('bolt11');
      const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
        operation.mintUrl,
        operation.unit,
      );
      const context = {
        operation,
        wallet,
        mintAdapter: this.dependencies.mintAdapter,
        logger: this.dependencies.logger,
      };
      let proofs: Proof[];
      if (newlyAuthorized) {
        const result = await handler.execute(context);
        if (result.status === 'FAILED') throw new Error('Destination issuance remains unresolved');
        proofs =
          result.status === 'ISSUED' ? result.proofs : await this.restoreDestination(operation);
      } else {
        const siblings = await this.dependencies.destinationQueries.getByQuoteId(
          operation.mintUrl,
          'bolt11',
          operation.quoteId,
        );
        const result = await handler.recoverExecuting({
          ...context,
          restoreOutputs: () => this.restoreDestination(operation),
          recordQuoteSnapshot: async (snapshot) => {
            await this.dependencies.quoteLifecycle.recordMintQuoteSnapshot(
              operation.mintUrl,
              'bolt11',
              snapshot,
            );
          },
          localClaimabilityFacts: {
            finalizedAmount: Amount.sum(
              siblings.filter((value) => value.state === 'finalized').map((value) => value.amount),
            ),
            reservedAmount: Amount.sum(
              siblings
                .filter((value) => value.state === 'executing' && value.id !== operation.id)
                .map((value) => value.amount),
            ),
          },
        });
        if (result.status === 'REJECTED')
          throw new MintSwapInvariantError('child_identity', 'child_conflict', 'destination');
        if (result.status !== 'ISSUED') return parent;
        proofs = result.proofs;
      }
      now = this.now();
      parent = await this.commit(parent.id, (tx) =>
        tx.perform(applyMintSwapDestination, { id: parent.id, operation, proofs, now }),
      );

      return parent;
    } catch (error) {
      return this.handleError(parent.id, error);
    } finally {
      release();
    }
  }

  private async restoreDestination(operation: ExecutingMintOperation): Promise<Proof[]> {
    const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(operation.mintUrl);
    const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
      operation.mintUrl,
      operation.unit,
    );
    return restoreOutputProofs(wallet, metadata.keysets, operation.unit, operation.outputData);
  }

  private async handleError(
    id: string,
    error: unknown,
    allowRejection = false,
  ): Promise<MintSwapOperation> {
    const now = this.now();
    if (error instanceof MintSwapInvariantError)
      return this.commit(id, (tx) => tx.perform(flagMintSwapAttention, { id, now, error }));
    const parent = await this.requireParent(id);
    if (
      allowRejection &&
      error instanceof ProofValidationError &&
      (parent.state === 'preparing' || parent.state === 'prepared')
    )
      return this.commit(id, (tx) =>
        tx.perform(cancelMintSwap, {
          id,
          now,
          failure: {
            code:
              error instanceof MintSwapDebitCapError
                ? 'source_debit_cap_exceeded'
                : 'preparation_rejected',
          },
        }),
      );
    // No raw error payload is persisted: it may contain protocol secrets.
    const retryAfter =
      error instanceof RateLimitError &&
      Number.isFinite(error.retryAfterMs) &&
      error.retryAfterMs! >= 0
        ? now + Math.ceil(error.retryAfterMs!)
        : undefined;
    return this.defer(parent, true, retryAfter);
  }

  private async defer(parent: MintSwapOperation, ambiguous = false, retryAfter?: number) {
    const now = this.now();
    const random = this.random();
    const error = ambiguous
      ? parent.state === 'source_pending'
        ? { category: 'ambiguous' as const, code: 'source_outcome_unknown' as const }
        : parent.state === 'destination_pending'
          ? { category: 'ambiguous' as const, code: 'destination_outcome_unknown' as const }
          : { category: 'transient' as const, code: 'remote_unavailable' as const }
      : {
          category: 'waiting' as const,
          code:
            parent.state === 'source_pending'
              ? ('source_pending' as const)
              : ('destination_pending' as const),
        };
    return this.commit(parent.id, (tx) =>
      tx.perform(deferMintSwap, { id: parent.id, now, random, error, retryAfter }),
    );
  }

  private async requireParent(id: string) {
    const parent = await this.dependencies.parentQueries.getById(id);
    if (!parent) throw new Error('Mint Swap was not found');
    return parent;
  }

  private async withParent<T>(id: string, work: () => Promise<T>): Promise<T> {
    while (this.parentLock.isLocked(id)) await this.parentLock.waitForUnlock(id);
    const release = await this.parentLock.acquire(id);
    const changes: Array<{ before: ChildSnapshot; after: ChildSnapshot }> = [];
    this.committedChanges.set(id, changes);
    try {
      return await work();
    } finally {
      this.committedChanges.delete(id);
      release();
      // Listeners may call a child API and wait for its lock. Flush after the operation's locks
      // are released, using the snapshots captured at each successful commit.
      for (const change of changes) await this.publishChanges(change.before, change.after);
    }
  }

  private async emit<E extends keyof CoreEvents>(event: E, payload: CoreEvents[E]) {
    try {
      await this.dependencies.eventBus.emit(event, payload, { throwOnError: true });
    } catch {
      this.dependencies.logger?.warn('Mint Swap child event listener failed after commit', {
        event,
      });
    }
  }

  /** Capture child/proof changes in the owning attempt; publish only its committed snapshot. */
  private async commit<T>(id: string, work: (tx: CoreTransaction) => Promise<T>): Promise<T> {
    const committed = await this.dependencies.transactionRunner.run(async (tx) => {
      const before = await this.childSnapshot(tx, id);
      const result = await work(tx);
      const after = await this.childSnapshot(tx, id);
      return { result, before, after };
    });
    this.committedChanges.get(id)!.push({ before: committed.before, after: committed.after });
    return committed.result;
  }

  private async childSnapshot(tx: CoreTransaction, id: string): Promise<ChildSnapshot> {
    const parent = await tx.mintSwapOperations!.getById(id);
    if (!parent) throw new Error('Mint Swap was not found');
    const source = await tx.meltOperations.getById(parent.sourceOperationId);
    const destination = await tx.mintOperations.getById(parent.destinationOperationId);
    const sourceSecrets =
      source && source.state !== 'init' && source.changeOutputData
        ? [
            ...source.inputProofSecrets,
            ...getSecretsFromSerializedOutputData(source.changeOutputData).keepSecrets,
            ...(source.swapOutputData
              ? Object.values(getSecretsFromSerializedOutputData(source.swapOutputData)).flat()
              : []),
          ]
        : [];
    const destinationSecrets =
      destination && destination.state !== 'init' && destination.outputData
        ? Object.values(getSecretsFromSerializedOutputData(destination.outputData)).flat()
        : [];
    const sourceProofs = await tx.proofs.getProofsBySecrets(parent.sourceMintUrl, sourceSecrets);
    const destinationProofs = await tx.proofs.getProofsBySecrets(
      parent.destinationMintUrl,
      destinationSecrets,
    );
    const counters: Counter[] = [];
    const sourceOutputs =
      source && source.state !== 'init'
        ? [source.changeOutputData, source.swapOutputData].filter((value) => value !== undefined)
        : [];
    const destinationOutputs =
      destination && destination.state !== 'init' && destination.outputData
        ? [destination.outputData]
        : [];
    for (const [mintUrl, plans] of [
      [parent.sourceMintUrl, sourceOutputs],
      [parent.destinationMintUrl, destinationOutputs],
    ] as const) {
      const ids = new Set(
        plans.flatMap((plan) =>
          [...plan.keep, ...plan.send].map((output) => output.blindedMessage.id),
        ),
      );
      for (const keysetId of ids) {
        const counter = await tx.outputs.getCounter(mintUrl, keysetId);
        if (counter) counters.push(counter);
      }
    }
    return { source, destination, proofs: [...sourceProofs, ...destinationProofs], counters };
  }

  private async publishChanges(before: ChildSnapshot, after: ChildSnapshot) {
    for (const counter of after.counters) {
      if (
        !before.counters.some(
          (previous) =>
            previous.mintUrl === counter.mintUrl &&
            previous.keysetId === counter.keysetId &&
            previous.counter === counter.counter,
        )
      )
        await this.emit('counter:updated', counter);
    }
    for (const proof of after.proofs) {
      const previous = before.proofs.find(
        (value) => value.mintUrl === proof.mintUrl && value.secret === proof.secret,
      );
      if (!previous) {
        if (
          proof.usedByOperationId &&
          proof.usedByOperationId === after.source?.id &&
          proof.createdByOperationId !== after.source?.id
        )
          await this.emit('proofs:reserved', {
            mintUrl: proof.mintUrl,
            operationId: proof.usedByOperationId,
            secrets: [proof.secret],
            amount: { amount: proof.amount, unit: proof.unit },
          });
        else
          await this.emit('proofs:saved', {
            mintUrl: proof.mintUrl,
            keysetId: proof.id,
            proofs: [proof],
          });
      } else {
        if (previous.state !== proof.state)
          await this.emit('proofs:state-changed', {
            mintUrl: proof.mintUrl,
            secrets: [proof.secret],
            state: proof.state,
          });
        if (previous.usedByOperationId && !proof.usedByOperationId)
          await this.emit('proofs:released', { mintUrl: proof.mintUrl, secrets: [proof.secret] });
        if (proof.usedByOperationId && previous.usedByOperationId !== proof.usedByOperationId)
          await this.emit('proofs:reserved', {
            mintUrl: proof.mintUrl,
            operationId: proof.usedByOperationId,
            secrets: [proof.secret],
            amount: { amount: proof.amount, unit: proof.unit },
          });
      }
    }
    if (after.source && before.source?.state !== after.source.state) {
      const operation = after.source;
      const payload = { mintUrl: operation.mintUrl, operationId: operation.id, operation };
      switch (operation.state) {
        case 'prepared':
          await this.emit('melt-op:prepared', payload);
          break;
        case 'pending':
          await this.emit('melt-op:pending', payload);
          break;
        case 'finalized':
          await this.emit('melt-op:finalized', payload);
          break;
        case 'rolled_back':
          await this.emit('melt-op:rolled-back', payload);
          break;
      }
    }
    if (after.destination && before.destination?.state !== after.destination.state) {
      const operation = after.destination;
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
      }
    }
  }
}
