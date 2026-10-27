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
  private readonly retiredByKey = new Map<QuoteKey, Set<Promise<void>>>();
  private readonly ownerRemovals = new Map<string, Promise<void>>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly interests = new QuoteWatchInterests();
  private readonly watchRecordByKey = new Map<QuoteKey, QuoteWatchRecord>();
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
    const ownerKey = `${owner.kind}:${owner.id}`;
    const cleanup: Promise<void>[] = [];
    const previous = this.ownerRemovals.get(ownerKey);
    if (previous) cleanup.push(previous);
    for (const key of this.interests.keysFor(owner)) {
      this.interests.remove(key, owner);
      const record = this.watchRecordByKey.get(key);
      if (!this.interests.hasAny(key)) cleanup.push(this.stopWatching(key));
      else if (record && !this.interests.hasRecovery(key)) {
        cleanup.push(this.stopIfUntrusted(record));
      }
    }
    const task = this.own(Promise.all(cleanup).then(() => {}));
    this.ownerRemovals.set(ownerKey, task);
    void task.then(
      () => {
        if (this.ownerRemovals.get(ownerKey) === task) this.ownerRemovals.delete(ownerKey);
      },
      () => {
        if (this.ownerRemovals.get(ownerKey) === task) this.ownerRemovals.delete(ownerKey);
      },
    );
    return task;
  }

  private async stopIfUntrusted(record: QuoteWatchRecord): Promise<void> {
    const key = quoteWatchKey(record);
    const trusted = await this.mintService.isTrustedMint(record.mintUrl);
    if (!trusted && !this.interests.hasRecovery(key) && this.watchRecordByKey.get(key) === record)
      await this.stopWatching(key);
  }

  /** Retry failed activation on an explicit enable; skipped untrusted interests stay skipped. */
  retryFailedInterests(): void {
    this.retryFailedRecords();
  }

  private retryFailedRecords(operationOnly = false): void {
    if (!this.running) return;
    for (const [key, record] of this.watchRecordByKey) {
      if (record.failed && (!operationOnly || this.interests.hasKind(key, 'operation')))
        void this.activateWatchRecord(record, this.getPolicy(record.method));
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

    // Retire every record before awaiting any acquisition or unsubscribe.
    for (const key of Array.from(this.watchRecordByKey.keys())) this.stopWatching(key);
    while (this.retiredByKey.size > 0) {
      await Promise.all(Array.from(this.retiredByKey.values()).flatMap((tasks) => [...tasks]));
    }
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

  /** @internal Preserve retries limited to ordinary operation interests. */
  retryFailedOperationInterests(): void {
    this.retryFailedRecords(true);
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
    return this.activateWatchRecord(record, policy);
  }

  private activateWatchRecord(
    record: QuoteWatchRecord,
    policy: MeltQuoteWatchPolicy,
  ): Promise<void> {
    record.failed = false;
    const task = this.own(this.startWatchingRecord(record, policy));
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
    const key = toKey(quote.mintUrl, quote.method, quote.quoteId);
    let record = this.watchRecordByKey.get(key);
    if (!record) {
      record = {
        mintUrl: quote.mintUrl,
        method: quote.method,
        quoteId: quote.quoteId,
        subscriptionKind: policy.subscriptionKind,
      };
      this.watchRecordByKey.set(key, record);
    }

    return record;
  }

  private async startWatchingRecord(
    record: QuoteWatchRecord,
    policy: MeltQuoteWatchPolicy,
  ): Promise<void> {
    const key = toKey(record.mintUrl, record.method, record.quoteId);

    let unsubscribe: UnsubscribeHandler | undefined;
    try {
      // A replacement must not reuse a physical subscription that an old record is still closing.
      const retired = this.retiredByKey.get(key);
      if (retired) await Promise.all([...retired]);
      if (!this.running || this.watchRecordByKey.get(key) !== record) return;

      const trusted = await this.mintService.isTrustedMint(record.mintUrl);
      if (!this.running || this.watchRecordByKey.get(key) !== record) return;
      if (!trusted && !this.interests.hasRecovery(key)) {
        this.logger?.debug('Skipping melt quote watch for untrusted mint', {
          mintUrl: record.mintUrl,
          quoteId: record.quoteId,
        });
        return;
      }

      const quote = await this.quoteLifecycle.getMeltQuote(
        record.mintUrl,
        record.method,
        record.quoteId,
      );
      if (!this.running || this.watchRecordByKey.get(key) !== record) return;
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
      if (this.watchRecordByKey.get(key) === record) record.failed = true;
      this.logger?.warn('Failed to start melt quote watch', {
        mintUrl: record.mintUrl,
        method: record.method,
        quoteId: record.quoteId,
        owners: this.interests.owners(key),
        err,
      });
      return;
    }

    if (!this.running || this.watchRecordByKey.get(key) !== record) {
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
    if (!this.running || this.watchRecordByKey.get(key) !== record) return;
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

      if (!this.running || this.watchRecordByKey.get(key) !== record) return;

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
    const record = this.watchRecordByKey.get(key);
    if (!record) return Promise.all([...(this.retiredByKey.get(key) ?? [])]).then(() => {});
    this.watchRecordByKey.delete(key);

    const task = (async () => {
      try {
        await record.start;
        await record.stop?.();
      } catch (err) {
        this.logger?.warn('Unsubscribe melt quote watcher failed', { key, err });
      }
    })();
    const retired = this.retiredByKey.get(key) ?? new Set<Promise<void>>();
    this.retiredByKey.set(key, retired);
    retired.add(task);
    void task.then(() => {
      retired.delete(task);
      if (retired.size === 0 && this.retiredByKey.get(key) === retired)
        this.retiredByKey.delete(key);
    });
    return task;
  }

  private async handleMintUntrusted(mintUrl: string, generation: number): Promise<void> {
    const normalized = normalizeMintUrl(mintUrl);
    const recovery = [...this.watchRecordByKey.values()].filter(
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

  async stopWatchingMint(mintUrl: string): Promise<void> {
    const prefix = `${normalizeMintUrl(mintUrl)}::`;
    const cleanup = Array.from(this.watchRecordByKey.keys())
      .filter((key) => key.startsWith(prefix))
      .map((key) => this.stopWatching(key));
    for (const [key, retired] of this.retiredByKey) {
      if (key.startsWith(prefix)) cleanup.push(...retired);
    }
    await Promise.all(cleanup);
  }
}
