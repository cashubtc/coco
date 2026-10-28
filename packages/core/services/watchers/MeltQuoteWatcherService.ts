import type { EventBus, CoreEvents } from '@core/events';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import type { SubscriptionKind } from '@core/infra/SubscriptionProtocol.ts';
import {
  meltQuoteFromBolt11Response,
  meltQuoteFromBolt12Response,
  meltQuoteFromOnchainResponse,
  type MeltQuote,
} from '@core/models/MeltQuote.ts';
import type { MeltMethod, MeltMethodQuoteSnapshot } from '@core/operations/melt';
import type { QuoteLifecycle } from '@core/quotes/QuoteLifecycle.ts';
import type { MintService } from '@core/services/MintService.ts';
import type { Logger } from '../../logging/Logger.ts';
import { normalizeMintUrl } from '../../utils.ts';
import {
  QuoteWatchInterests,
  canonicalQuoteOwner,
  quoteWatchKey,
  type QuoteWatchOwner,
  type QuoteWatchInterest,
  type QuoteWatchIdentity,
} from './QuoteWatchInterests.ts';
import { QuoteWatchRecords } from './QuoteWatchRecords.ts';

type QuoteKey = string; // `${mintUrl}::${method}::${quoteId}`

interface WatchableMeltQuote {
  mintUrl: string;
  method: MeltMethod;
  quoteId: string;
  quote?: MeltQuote;
}

interface MeltQuoteWatchPolicy<M extends MeltMethod = MeltMethod> {
  subscriptionKind: SubscriptionKind;
  getPayloadQuoteId(payload: unknown): string | undefined;
  toCanonicalQuote(mintUrl: string, payload: MeltMethodQuoteSnapshot<M>): MeltQuote<M>;
}

interface QuoteWatchRecord {
  mintUrl: string;
  method: MeltMethod;
  quoteId: string;
  subscriptionKind: SubscriptionKind;
  start?: Promise<void>;
  stop?: UnsubscribeHandler;
  failed?: boolean;
}

export interface MeltQuoteWatcherOptions {
  // If true, on start() the watcher will also load and watch all pending canonical melt quotes.
  watchExistingPendingQuotesOnStart?: boolean;
}

export interface MeltQuoteOperationInterest {
  operationId: string;
  mintUrl: string;
  method: MeltMethod;
  quoteId: string;
}

function toKey(mintUrl: string, method: string, quoteId: string): QuoteKey {
  return quoteWatchKey({ mintUrl, method: method as MeltMethod, quoteId });
}

function isExpiredMeltQuote(quote: Pick<MeltQuote, 'expiry'>): boolean {
  return quote.expiry * 1000 <= Date.now();
}

function isMeltQuoteState(value: unknown): value is MeltQuote['state'] {
  return value === 'UNPAID' || value === 'PENDING' || value === 'PAID';
}

function hasMeltQuotePayload(method: MeltMethod, payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const quote = payload as Record<string, unknown>;
  if (
    typeof quote.quote !== 'string' ||
    typeof quote.request !== 'string' ||
    quote.amount === undefined ||
    typeof quote.unit !== 'string' ||
    typeof quote.expiry !== 'number' ||
    !isMeltQuoteState(quote.state)
  ) {
    return false;
  }

  if (method === 'onchain') {
    return Array.isArray(quote.fee_options);
  }

  return quote.fee_reserve !== undefined;
}

const CANONICAL_INTEREST = canonicalQuoteOwner;

const meltQuoteWatchPolicies: {
  [M in MeltMethod]: MeltQuoteWatchPolicy<M>;
} = {
  bolt11: {
    subscriptionKind: 'bolt11_melt_quote',
    getPayloadQuoteId: (payload) =>
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as { quote?: unknown }).quote === 'string'
        ? (payload as { quote: string }).quote
        : undefined,
    toCanonicalQuote: (mintUrl, payload) => meltQuoteFromBolt11Response(mintUrl, payload),
  },
  bolt12: {
    subscriptionKind: 'bolt12_melt_quote',
    getPayloadQuoteId: (payload) =>
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as { quote?: unknown }).quote === 'string'
        ? (payload as { quote: string }).quote
        : undefined,
    toCanonicalQuote: (mintUrl, payload) => meltQuoteFromBolt12Response(mintUrl, payload),
  },
  onchain: {
    subscriptionKind: 'onchain_melt_quote',
    getPayloadQuoteId: (payload) =>
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as { quote?: unknown }).quote === 'string'
        ? (payload as { quote: string }).quote
        : undefined,
    toCanonicalQuote: (mintUrl, payload) => meltQuoteFromOnchainResponse(mintUrl, payload),
  },
};

export class MeltQuoteWatcherService {
  private readonly subs: SubscriptionManager;
  private readonly mintService: MintService;
  private readonly quoteLifecycle: QuoteLifecycle;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly options: Required<MeltQuoteWatcherOptions>;

  private running = false;
  private generation = 0;
  private stopping?: Promise<void>;
  private readonly work = new Set<Promise<unknown>>();
  private readonly interests = new QuoteWatchInterests();
  private readonly records: QuoteWatchRecords<QuoteWatchRecord>;
  private offQuoteUpdated?: () => void;
  private offUntrusted?: () => void;

  constructor(
    subs: SubscriptionManager,
    mintService: MintService,
    quoteLifecycle: QuoteLifecycle,
    bus: EventBus<CoreEvents>,
    logger?: Logger,
    options?: MeltQuoteWatcherOptions,
  ) {
    this.subs = subs;
    this.mintService = mintService;
    this.quoteLifecycle = quoteLifecycle;
    this.bus = bus;
    this.logger = logger;
    this.options = {
      watchExistingPendingQuotesOnStart: options?.watchExistingPendingQuotesOnStart ?? true,
    };
    this.records = new QuoteWatchRecords({
      label: 'melt',
      interests: this.interests,
      isTrustedMint: (mintUrl) => this.mintService.isTrustedMint(mintUrl),
      logger,
    });
  }

  /** Exact authorized observation permission, independent of subscription readiness. */
  hasRecoveryInterest(quote: QuoteWatchIdentity): boolean {
    return this.running && this.interests.hasRecovery(quoteWatchKey(quote));
  }

  private own<T>(task: Promise<T>): Promise<T> {
    this.work.add(task);
    void task.then(
      () => this.work.delete(task),
      () => this.work.delete(task),
    );
    return task;
  }

  /** Declare local ownership immediately; this watcher owns asynchronous activation and errors. */
  registerInterest(interest: QuoteWatchInterest): void {
    if (!this.running) return;
    void this.addWatchInterest(interest, interest.owner);
  }

  /** Withdraw every declaration before waiting for acquisition, trust checks, or cleanup. */
  removeInterest(owner: QuoteWatchOwner): Promise<void> {
    return this.own(this.records.removeInterest(owner));
  }

  /** Retry failed activation on an explicit enable; skipped untrusted interests stay skipped. */
  retryFailedInterests(): void {
    if (!this.running) return;
    for (const record of this.records.values()) {
      if (record.failed) void this.activateWatchRecord(record, this.getPolicy(record.method));
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.stopping) {
      await this.stopping;
      return;
    }
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    this.logger?.info('MeltQuoteWatcherService started');

    this.offQuoteUpdated = this.bus.on('melt-quote:updated', async ({ quote }) => {
      try {
        if (this.isActive(generation)) await this.own(this.handleCanonicalQuoteUpdate(quote));
      } catch (err) {
        this.logger?.error('Failed to handle canonical melt quote update', {
          mintUrl: quote.mintUrl,
          method: quote.method,
          quoteId: quote.quoteId,
          err,
        });
      }
    });

    this.offUntrusted = this.bus.on('mint:untrusted', async ({ mintUrl }) => {
      try {
        if (this.isActive(generation))
          await this.own(this.handleMintUntrusted(mintUrl, generation));
      } catch (err) {
        this.logger?.error('Failed to stop watching melt quotes on untrust', { mintUrl, err });
      }
    });

    if (this.options.watchExistingPendingQuotesOnStart) {
      try {
        const quotes = await this.quoteLifecycle.getPendingMeltQuotes();
        if (!this.isActive(generation)) return;
        await this.watchMeltQuotes(
          quotes.map((quote) => ({
            mintUrl: quote.mintUrl,
            method: quote.method,
            quoteId: quote.quoteId,
            quote,
          })),
          CANONICAL_INTEREST,
        );
      } catch (err) {
        this.logger?.error('Failed to load pending melt quotes to watch', { err });
      }
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.running) return Promise.resolve();
    this.running = false;
    const task = this.finishStop();
    this.stopping = task;
    void task.then(
      () => {
        this.stopping = undefined;
      },
      () => {
        this.stopping = undefined;
      },
    );
    return task;
  }

  private async finishStop(): Promise<void> {
    if (this.offQuoteUpdated) {
      try {
        this.offQuoteUpdated();
      } finally {
        this.offQuoteUpdated = undefined;
      }
    }

    if (this.offUntrusted) {
      try {
        this.offUntrusted();
      } finally {
        this.offUntrusted = undefined;
      }
    }

    await this.records.stopAll();
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
    this.interests.clear();
    this.logger?.info('MeltQuoteWatcherService stopped');
  }

  /**
   * @internal Declare observation interest synchronously. Return means local acceptance, not
   * subscription readiness or remote acceptance. This watcher owns setup and reports failures.
   * A repeated declaration may retry failed or previously skipped setup; it does not start a loop.
   */
  registerOperationInterest(interest: MeltQuoteOperationInterest): void {
    this.registerInterest({ ...interest, owner: { kind: 'operation', id: interest.operationId } });
  }

  /** @internal Ordinary and parent owners have independent identities and cleanup. */
  removeOperationInterest(operationId: string): Promise<void> {
    return this.removeInterest({ kind: 'operation', id: operationId });
  }

  private isActive(generation: number): boolean {
    return this.running && this.generation === generation;
  }

  private async handleCanonicalQuoteUpdate(quote: MeltQuote): Promise<void> {
    const key = toKey(quote.mintUrl, quote.method, quote.quoteId);

    if (quote.state === 'PAID' && Array.isArray(quote.change)) {
      this.interests.remove(key, CANONICAL_INTEREST);
      await this.stopWatching(key);
      return;
    }

    if (isExpiredMeltQuote(quote)) {
      this.interests.remove(key, CANONICAL_INTEREST);
      if (!this.interests.hasAny(key)) {
        await this.stopWatching(key);
      }
      return;
    }

    await this.watchMeltQuotes(
      [
        {
          mintUrl: quote.mintUrl,
          method: quote.method,
          quoteId: quote.quoteId,
          quote,
        },
      ],
      CANONICAL_INTEREST,
    );
  }

  private async watchMeltQuotes(
    quotes: WatchableMeltQuote[],
    interest: QuoteWatchOwner,
  ): Promise<void> {
    const generation = this.generation;
    for (const quote of quotes) {
      if (!this.isActive(generation)) return;
      await this.addWatchInterest(quote, interest);
    }
  }

  private addWatchInterest(input: WatchableMeltQuote, interest: QuoteWatchOwner): Promise<void> {
    if (!this.running) return Promise.resolve();
    const quote = { ...input, mintUrl: normalizeMintUrl(input.mintUrl) };
    const key = quoteWatchKey(quote);
    this.interests.add(key, interest);
    if (quote.quote?.state === 'PAID' && Array.isArray(quote.quote.change)) {
      this.interests.remove(key, CANONICAL_INTEREST);
      return this.stopWatching(key);
    }
    if (interest.kind === 'canonical' && quote.quote && isExpiredMeltQuote(quote.quote)) {
      this.interests.remove(key, CANONICAL_INTEREST);
      return this.interests.hasAny(key) ? Promise.resolve() : this.stopWatching(key);
    }
    const policy = this.getPolicy(quote.method);
    const record = this.ensureWatchRecord(quote, policy);
    // An acquisition can itself publish a canonical observation. Never join that acquisition
    // from its canonical event listener, which would wait on its own publication.
    if (record.start) return interest.kind === 'canonical' ? Promise.resolve() : record.start;
    if (record.stop) return Promise.resolve();
    return this.activateWatchRecord(record, policy, quote.quote);
  }

  /** `known` is a canonical quote the caller already holds; activation then skips the reread. */
  private activateWatchRecord(
    record: QuoteWatchRecord,
    policy: MeltQuoteWatchPolicy,
    known?: MeltQuote,
  ): Promise<void> {
    record.failed = false;
    const task = this.own(this.startWatchingRecord(record, policy, known));
    record.start = task;
    void task.then(() => {
      if (record.start === task) record.start = undefined;
    });
    return task;
  }

  private getPolicy<M extends MeltMethod>(method: M): MeltQuoteWatchPolicy<M> {
    return meltQuoteWatchPolicies[method] as MeltQuoteWatchPolicy<M>;
  }

  private ensureWatchRecord(
    quote: WatchableMeltQuote,
    policy: MeltQuoteWatchPolicy,
  ): QuoteWatchRecord {
    return this.records.ensure(toKey(quote.mintUrl, quote.method, quote.quoteId), () => ({
      mintUrl: quote.mintUrl,
      method: quote.method,
      quoteId: quote.quoteId,
      subscriptionKind: policy.subscriptionKind,
    }));
  }

  private current(record: QuoteWatchRecord): boolean {
    return this.running && this.records.isCurrent(record);
  }

  private async startWatchingRecord(
    record: QuoteWatchRecord,
    policy: MeltQuoteWatchPolicy,
    known?: MeltQuote,
  ): Promise<void> {
    const key = toKey(record.mintUrl, record.method, record.quoteId);

    let unsubscribe: UnsubscribeHandler | undefined;
    try {
      // A replacement must not reuse a physical subscription that an old record is still closing.
      const retired = this.records.retiredCleanup(key);
      if (retired) await retired;
      if (!this.current(record)) return;

      const trusted = await this.mintService.isTrustedMint(record.mintUrl);
      if (!this.current(record)) return;
      if (!trusted && !this.interests.hasRecovery(key)) {
        this.logger?.debug('Skipping melt quote watch for untrusted mint', {
          mintUrl: record.mintUrl,
          quoteId: record.quoteId,
        });
        return;
      }

      // Settling canonical updates retire this record, so a supplied quote is safe for this check.
      const quote =
        known ??
        (await this.quoteLifecycle.getMeltQuote(record.mintUrl, record.method, record.quoteId));
      if (!this.current(record)) return;
      if (quote?.state === 'PAID' && Array.isArray(quote.change)) {
        this.interests.remove(key, CANONICAL_INTEREST);
        // Retire synchronously, but do not await our own acquisition.
        void this.stopWatching(key);
        return;
      }

      const subscription = await this.subs.subscribe(
        record.mintUrl,
        policy.subscriptionKind,
        [record.quoteId],
        async (payload) => {
          await this.own(this.handleSubscriptionPayload(record, payload));
        },
      );
      unsubscribe = subscription.unsubscribe;
    } catch (err) {
      if (this.records.isCurrent(record)) record.failed = true;
      this.logger?.warn('Failed to start melt quote watch', {
        mintUrl: record.mintUrl,
        method: record.method,
        quoteId: record.quoteId,
        owners: this.interests.owners(key),
        err,
      });
      return;
    }

    if (!this.current(record)) {
      try {
        await unsubscribe?.();
      } catch (err) {
        this.logger?.warn('Unsubscribe melt quote watcher failed', { key, err });
      }
      return;
    }

    record.stop = async () => {
      await unsubscribe?.();
    };

    this.logger?.debug('Watching melt quote', {
      mintUrl: record.mintUrl,
      method: record.method,
      quoteId: record.quoteId,
    });
  }

  private async handleSubscriptionPayload(
    record: QuoteWatchRecord,
    payload: unknown,
  ): Promise<void> {
    const key = toKey(record.mintUrl, record.method, record.quoteId);
    if (!this.current(record)) return;
    const policy = this.getPolicy(record.method);
    if (
      !hasMeltQuotePayload(record.method, payload) ||
      policy.getPayloadQuoteId(payload) !== record.quoteId
    ) {
      return;
    }

    try {
      const quote = await this.quoteLifecycle.recordMeltQuoteObservation(
        policy.toCanonicalQuote(
          record.mintUrl,
          payload as MeltMethodQuoteSnapshot<typeof record.method>,
        ),
      );

      if (!this.current(record)) return;

      if (quote.state === 'PAID' && Array.isArray(quote.change)) {
        this.interests.remove(key, CANONICAL_INTEREST);
        await this.stopWatching(key);
        return;
      }

      if (isExpiredMeltQuote(quote)) {
        this.interests.remove(key, CANONICAL_INTEREST);
        if (!this.interests.hasAny(key)) {
          await this.stopWatching(key);
        }
      }
    } catch (err) {
      this.logger?.error('Failed to persist melt quote update from remote update', {
        mintUrl: record.mintUrl,
        method: record.method,
        quoteId: record.quoteId,
        err,
      });
    }
  }

  private stopWatching(key: QuoteKey): Promise<void> {
    return this.records.stopWatching(key);
  }

  private async handleMintUntrusted(mintUrl: string, generation: number): Promise<void> {
    const normalized = normalizeMintUrl(mintUrl);
    const recovery = this.records
      .values()
      .filter(
        (record) =>
          record.mintUrl === normalized && this.interests.hasRecovery(quoteWatchKey(record)),
      );
    // Manager has closed this mint's transport. Retire every old record before rebuilding
    // only interests whose exact recovery permission is still owned after cleanup.
    await this.stopWatchingMint(normalized);
    if (!this.isActive(generation)) return;
    for (const quote of recovery) {
      if (!this.isActive(generation)) return;
      if (!this.interests.hasRecovery(quoteWatchKey(quote))) continue;
      const policy = this.getPolicy(quote.method);
      await this.activateWatchRecord(this.ensureWatchRecord(quote, policy), policy);
    }
  }

  stopWatchingMint(mintUrl: string): Promise<void> {
    return this.records.stopWatchingMint(mintUrl);
  }
}
