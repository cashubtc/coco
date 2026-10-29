import { RateLimitError, type Proof } from '@cashu/cashu-ts';
import type { DeferPublication } from '../../events/DeferredPublication.ts';
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
import { NullLogger } from '../../logging/NullLogger.ts';
import type { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { MintSwapOperation } from './MintSwapOperation.ts';
import { isMintSwapAutomaticState, isMintSwapTerminalState } from './MintSwapOperation.ts';
import { OperationIdLock } from '../OperationIdLock.ts';
import type { MintScopedLock } from '../MintScopedLock.ts';
import { createKeyChain } from '../../proofs/KeysetSelection.ts';
import { generateSubId, getSecretsFromSerializedOutputData } from '../../utils.ts';
import { OperationInProgressError, ProofValidationError } from '../../models/Error.ts';
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
  normalizeMintSwapIntent,
  type MintSwapIntent,
} from './MintSwapValidation.ts';
import {
  MintSwapDebitCapError,
  MintSwapIdentityConflictError,
  MintSwapInvariantError,
} from './MintSwapErrors.ts';
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
  parent: MintSwapOperation | null;
  source: MeltOperation | null;
  destination: MintOperation | null;
  proofs: CoreProof[];
  counters: Counter[];
}

export interface MintSwapOperationServiceDependencies {
  transactionRunner: CoreTransactionRunner;
  parentQueries: Pick<MintSwapOperationRepository, 'getById' | 'listActive' | 'listDue'>;
  sourceQueries: Pick<MeltOperationRepository, 'getById'>;
  destinationQueries: Pick<MintOperationRepository, 'getById'>;
  proofQueries: Pick<ProofRepository, 'getProofsBySecrets'>;
  mintService: Pick<MintService, 'refreshAndCommitIfStale'>;
  walletService: Pick<WalletService, 'getWalletWithActiveKeysetId'>;
  keyRingService: Pick<KeyRingService, 'allocateAndCommitMintQuoteKeyPair'>;
  quoteLifecycle: Pick<
    QuoteLifecycle,
    | 'createMintQuote'
    | 'createMeltQuote'
    | 'getMeltQuote'
    | 'getMintQuote'
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
 * Internal coordinator. Requires one effect-driving Coco Session per Wallet store.
 * Child locks are shared with standalone processors; durable guards make local writes atomic,
 * but do not fence remote effects across independently running sessions.
 */
export class MintSwapOperationService {
  private readonly parentLock = new OperationIdLock();
  private readonly now: () => number;
  private readonly random: () => number;
  private disposed = false;
  private readonly work = new Set<Promise<unknown>>();
  private disposePromise?: Promise<void>;
  // Existing handlers can log remote payloads. Parent diagnostics use only bounded local hints.
  private readonly handlerLogger = new NullLogger();
  private readonly committedPublications = new Map<string, Array<() => Promise<void>>>();

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
          this.deferPublication(intent.id),
        );
        if (destination.pubkey !== key.publicKeyHex)
          throw new MintSwapInvariantError('quote_identity', 'quote_conflict', 'destination');
        const source = await this.dependencies.quoteLifecycle.createMeltQuote(
          intent.sourceMintUrl,
          'bolt11',
          { invoice: destination.request },
          'sat',
          this.deferPublication(intent.id),
        );
        const now = this.now();
        const candidate = {
          ...intent,
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
          parent = await this.commit(intent.id, (tx) => tx.perform(createMintSwap, candidate));
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

  /** Skip busy work and recheck durable eligibility after acquiring the parent lock. */
  async reconcileInBackground(id: string, startup = false): Promise<void> {
    try {
      await this.withParent(
        id,
        async () => {
          const parent = await this.requireParent(id);
          const due =
            isMintSwapAutomaticState(parent.state) &&
            parent.retry.nextAttemptAt !== null &&
            parent.retry.nextAttemptAt <= this.now();
          if (parent.state !== 'prepared' && !due) return;
          if (
            this.dependencies.sourceOperationLock.isLocked(parent.sourceOperationId) ||
            this.dependencies.destinationOperationLock.isLocked(parent.destinationOperationId)
          )
            return;
          await this.recoverParent(parent, !startup);
        },
        false,
      );
    } catch (error) {
      if (!(error instanceof OperationInProgressError)) throw error;
    }
  }

  getOperation(id: string): Promise<MintSwapOperation | null> {
    return this.own(() => this.dependencies.parentQueries.getById(id));
  }

  listActive(): Promise<MintSwapOperation[]> {
    return this.own(() => this.dependencies.parentQueries.listActive());
  }

  /** Close admission and drain complete commands, including preflight and event publication. */
  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposed = true;
      this.disposePromise = Promise.allSettled([...this.work]).then(() => {});
    }
    return this.disposePromise;
  }

  /** Startup scans include prepared parents so independently advanced children are adopted. */
  async recoverActive(): Promise<void> {
    return this.own(async () => {
      for (const parent of await this.dependencies.parentQueries.listActive()) {
        if (this.disposed) break;
        if (parent.state === 'needs_attention') continue;
        try {
          await this.reconcile(parent.id);
        } catch (error) {
          // Shared child services can own this attempt; leave it for the next scan.
          if (!(error instanceof OperationInProgressError)) throw error;
        }
      }
    });
  }

  async recoverDue(limit = 25): Promise<void> {
    return this.own(async () => {
      const dueAt = this.now();
      for (const candidate of await this.dependencies.parentQueries.listDue(dueAt, limit)) {
        if (this.disposed) break;
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
    });
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

  private async preflight(parent: MintSwapIntent | MintSwapOperation) {
    let sourceKeysetId: string | undefined;
    let destinationKeysetId: string | undefined;
    if ('state' in parent && parent.state === 'prepared') {
      // Preparation chooses keys; execution preserves the exact persisted plans. The source
      // authorization transition rechecks these plans and their active keys in its own scope.
      const sourceOperation = await this.dependencies.sourceQueries.getById(
        parent.sourceOperationId,
      );
      const destinationOperation = await this.dependencies.destinationQueries.getById(
        parent.destinationOperationId,
      );
      if (sourceOperation && sourceOperation.state !== 'init')
        sourceKeysetId =
          sourceOperation.changeOutputData?.keep[0]?.blindedMessage.id ??
          sourceOperation.swapOutputData?.keep[0]?.blindedMessage.id ??
          sourceOperation.swapOutputData?.send[0]?.blindedMessage.id;
      if (destinationOperation && destinationOperation.state !== 'init')
        destinationKeysetId = destinationOperation.outputData?.keep[0]?.blindedMessage.id;
    }
    const source = await this.dependencies.mintService.refreshAndCommitIfStale(
      parent.sourceMintUrl,
      this.deferPublication(parent.id),
    );
    const destination = await this.dependencies.mintService.refreshAndCommitIfStale(
      parent.destinationMintUrl,
      this.deferPublication(parent.id),
    );
    if (
      !(
        [
          [source, sourceKeysetId],
          [destination, destinationKeysetId],
        ] as const
      ).every(([metadata, keysetId]) =>
        metadata.keysets.some(
          (keyset) =>
            keyset.active &&
            keyset.unit === 'sat' &&
            (keysetId === undefined || keyset.id === keysetId),
        ),
      )
    )
      throw new ProofValidationError('Mint Swap active keys are unavailable');
    const sourceKeys = createKeyChain(parent.sourceMintUrl, 'sat', source.keysets)
      .getKeyset(sourceKeysetId)
      .toMintKeys();
    const destinationKeys = createKeyChain(parent.destinationMintUrl, 'sat', destination.keysets)
      .getKeyset(destinationKeysetId)
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
        this.deferPublication(parent.id),
      );
      const result = await handler.swap({
        operation: source,
        wallet,
        inputProofs: inputs,
        logger: this.handlerLogger,
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
    // The committed source authorization covers both pre-swap and payment. Later trust
    // revocation must not interrupt that exact request or its recovery.
    // Pre-swap I/O may outlive either payment deadline. Read both canonical quotes together,
    // then sample the clock after the read completes, immediately before submitting payment.
    const paymentDeadline = await this.dependencies.transactionRunner.run(async (tx) => {
      const sourceQuote = await tx.meltQuotes.getMeltQuote(
        parent.sourceMintUrl,
        'bolt11',
        parent.sourceQuote.quoteId,
      );
      const destinationQuote = await tx.mintQuotes.getMintQuote(
        parent.destinationMintUrl,
        'bolt11',
        parent.destinationQuote.quoteId,
      );
      if (!sourceQuote)
        throw new MintSwapInvariantError('quote_identity', 'quote_missing', 'source');
      if (!destinationQuote)
        throw new MintSwapInvariantError('quote_identity', 'quote_missing', 'destination');
      return Math.min(
        sourceQuote.expiry == null ? Infinity : sourceQuote.expiry * 1000,
        destinationQuote.expiry == null ? Infinity : destinationQuote.expiry * 1000,
      );
    });
    // Authorization has already committed: expiry defers recovery, never releases inputs here.
    if (this.now() >= paymentDeadline)
      throw new ProofValidationError('Mint Swap payment deadline has passed');
    const result = await handler.melt({
      operation: source,
      inputProofs: inputs,
      mintAdapter: this.dependencies.mintAdapter,
      logger: this.handlerLogger,
    });
    const existing = await this.dependencies.quoteLifecycle.getMeltQuote(
      source.mintUrl,
      'bolt11',
      source.quoteId,
    );
    if (!existing || existing.method !== 'bolt11')
      throw new MintSwapInvariantError('quote_identity', 'quote_missing', 'source');
    const now = this.now();
    const quote = await this.dependencies.quoteLifecycle.recordMeltQuoteObservation(
      {
        ...existing,
        state: result.status,
        change: result.change,
        payment_preimage: result.finalizedData?.preimage,
        lastObservedRemoteState: result.status,
        lastObservedRemoteStateAt: now,
        updatedAt: now,
      },
      this.deferPublication(parent.id),
    );
    await this.applySourceObservation(parent, operation, quote, false);
  }

  private async recoverParent(
    parent: MintSwapOperation,
    background = false,
  ): Promise<MintSwapOperation> {
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
          await this.observeSource(parent, background);
          const observedAt = this.now();
          parent = await this.commit(parent.id, (tx) =>
            tx.perform(reconcileMintSwap, { id: parent.id, now: observedAt }),
          );
        }
      }
      if (parent.state === 'source_pending') {
        // Payment may already have succeeded remotely even when its observation never committed.
        // Recover the authorized child regardless of current trust; never redispatch payment here.
        const source = await this.dependencies.sourceQueries.getById(parent.sourceOperationId);
        if (source?.state === 'executing' || source?.state === 'pending') {
          const quote = await this.observeSource(parent, background);
          if (!quote) return this.defer(parent);
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
    parent = await this.recoverDestination(await this.requireParent(parent.id), background);
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
      this.deferPublication(parent.id),
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
    const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(
      operation.mintUrl,
      this.deferPublication(parent.id),
    );
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
        this.deferPublication(parent.id),
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

  private async recoverDestination(
    parent: MintSwapOperation,
    background = false,
  ): Promise<MintSwapOperation> {
    if (parent.state !== 'destination_funded' && parent.state !== 'destination_pending')
      return parent;
    const release = await this.dependencies.destinationOperationLock.acquire(
      parent.destinationOperationId,
    );
    try {
      // Paid source value must remain redeemable through this persisted quote and output plan.
      // The scoped authorization below validates funding and ownership without restoring trust.
      const observedQuote = await this.observeDestination(parent, background);
      if (!observedQuote) return parent;
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
        this.deferPublication(parent.id),
      );
      const context = {
        operation,
        wallet,
        mintAdapter: this.dependencies.mintAdapter,
        logger: this.handlerLogger,
      };
      let proofs: Proof[];
      if (newlyAuthorized) {
        const result = await handler.execute(context);
        if (result.status === 'FAILED') throw new Error('Destination issuance remains unresolved');
        proofs =
          result.status === 'ISSUED'
            ? result.proofs
            : await this.restoreDestination(parent, operation);
      } else {
        const facts = await this.dependencies.transactionRunner.run((tx) =>
          tx.mintQuoteClaims.getFacts(
            { mintUrl: operation.mintUrl, method: 'bolt11', quoteId: operation.quoteId },
            { excludeOperationId: operation.id },
          ),
        );
        const result = await handler.recoverExecuting({
          ...context,
          observedQuote: observedQuote.method === 'bolt11' ? observedQuote : undefined,
          restoreOutputs: () => this.restoreDestination(parent, operation),
          recordQuoteSnapshot: async (snapshot) => {
            await this.dependencies.quoteLifecycle.recordMintQuoteSnapshot(
              operation.mintUrl,
              'bolt11',
              snapshot,
              this.deferPublication(parent.id),
            );
          },
          localClaimabilityFacts: {
            finalizedAmount: facts.finalizedAmount,
            reservedAmount: facts.reservedAmount,
          },
        });
        if (result.status === 'REJECTED')
          throw new MintSwapInvariantError('child_identity', 'child_conflict', 'destination');
        if (result.status !== 'ISSUED') {
          const retryAfter = this.retryDeadline(result.retryAfterMs);
          return retryAfter === undefined ? parent : this.defer(parent, true, retryAfter);
        }
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

  private async restoreDestination(
    parent: MintSwapOperation,
    operation: ExecutingMintOperation,
  ): Promise<Proof[]> {
    const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(
      operation.mintUrl,
      this.deferPublication(parent.id),
    );
    const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
      operation.mintUrl,
      operation.unit,
      this.deferPublication(parent.id),
    );
    return restoreOutputProofs(wallet, metadata.keysets, operation.unit, operation.outputData);
  }

  private async handleError(
    id: string,
    error: unknown,
    allowRejection = false,
  ): Promise<MintSwapOperation> {
    // A child can become busy after a background eligibility check. Contention is not a retry
    // failure and must not rewrite the parent's durable backoff or evidence.
    if (error instanceof OperationInProgressError) throw error;
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
    const retryAfter = this.retryDeadline(
      error instanceof RateLimitError ? error.retryAfterMs : undefined,
    );
    return this.defer(parent, true, retryAfter);
  }

  private retryDeadline(retryAfterMs: number | undefined): number | undefined {
    return retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? this.now() + Math.ceil(retryAfterMs)
      : undefined;
  }

  private async observeSource(
    parent: MintSwapOperation,
    background: boolean,
  ): Promise<MeltQuote | null> {
    const { mintUrl, method, quoteId } = parent.sourceQuote;
    if (background) {
      const quote = await this.dependencies.quoteLifecycle.getMeltQuote(mintUrl, method, quoteId);
      // Releasing source inputs requires a fresh check after the payment attempt has settled.
      if (!quote || quote.state !== 'UNPAID') return quote;
    }
    return this.dependencies.quoteLifecycle.refreshMeltQuote(
      mintUrl,
      method,
      quoteId,
      this.deferPublication(parent.id),
    );
  }

  private async observeDestination(parent: MintSwapOperation, background: boolean) {
    const { mintUrl, method, quoteId } = parent.destinationQuote;
    if (background) {
      const quote = await this.dependencies.quoteLifecycle.getMintQuote(mintUrl, method, quoteId);
      return quote;
    }
    return this.dependencies.quoteLifecycle.refreshMintQuote(
      mintUrl,
      method,
      quoteId,
      this.deferPublication(parent.id),
    );
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

  private own<T>(work: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Mint Swap runtime is disposed'));
    const promise = work();
    this.work.add(promise);
    void promise.then(
      () => this.work.delete(promise),
      () => this.work.delete(promise),
    );
    return promise;
  }

  private withParent<T>(id: string, work: () => Promise<T>, wait = true): Promise<T> {
    return this.own(() => this.runWithParent(id, work, wait));
  }

  private async runWithParent<T>(id: string, work: () => Promise<T>, wait: boolean): Promise<T> {
    if (wait) while (this.parentLock.isLocked(id)) await this.parentLock.waitForUnlock(id);
    const release = await this.parentLock.acquire(id);
    const publications: Array<() => Promise<void>> = [];
    this.committedPublications.set(id, publications);
    try {
      return await work();
    } finally {
      this.committedPublications.delete(id);
      release();
      // Listeners may call a child API and wait for its lock. Flush after the operation's locks
      // are released, using the snapshots captured at each successful commit.
      for (const publish of publications) await publish();
    }
  }

  private deferPublication(id: string): DeferPublication {
    const publications = this.committedPublications.get(id)!;
    return (publish) => publications.push(publish);
  }

  private async emit<E extends keyof CoreEvents>(event: E, payload: CoreEvents[E]) {
    try {
      await this.dependencies.eventBus.emit(event, payload, { throwOnError: true });
    } catch {
      this.dependencies.logger?.warn('Mint Swap event listener failed after commit', {
        event,
      });
    }
  }

  /** Capture parent/child/proof changes in the owning attempt; publish only its committed snapshot. */
  private async commit<T>(id: string, work: (tx: CoreTransaction) => Promise<T>): Promise<T> {
    const committed = await this.dependencies.transactionRunner.run(async (tx) => {
      const before = await this.childSnapshot(tx, id);
      const result = await work(tx);
      const after = await this.childSnapshot(tx, id);
      return { result, before, after };
    });
    this.committedPublications
      .get(id)!
      .push(() => this.publishChanges(committed.before, committed.after));
    return committed.result;
  }

  private async childSnapshot(tx: CoreTransaction, id: string): Promise<ChildSnapshot> {
    const parent = await tx.mintSwapOperations.getById(id);
    if (!parent) return { parent: null, source: null, destination: null, proofs: [], counters: [] };
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
    return {
      parent,
      source,
      destination,
      proofs: [...sourceProofs, ...destinationProofs],
      counters,
    };
  }

  private async publishChanges(before: ChildSnapshot, after: ChildSnapshot) {
    if (after.parent && before.parent?.revision !== after.parent.revision) {
      await this.emit('mint-swap:updated', {
        operationId: after.parent.id,
        revision: after.parent.revision,
        state: after.parent.state,
      });
    }
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
