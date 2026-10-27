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

type QuoteKey = string; // `${mintUrl}::${method}::${quoteId}`

type WatchInterestKind = 'canonical' | 'operation';

interface WatchInterest {
  kind: WatchInterestKind;
  id: string;
}

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
  return `${mintUrl}::${method}::${quoteId}`;
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

const CANONICAL_INTEREST: WatchInterest = { kind: 'canonical', id: 'canonical' };

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

class MeltQuoteInterestRegistry {
  private readonly interestsByKey = new Map<QuoteKey, Map<WatchInterestKind, Set<string>>>();

  add(key: QuoteKey, interest: WatchInterest): void {
    let byKind = this.interestsByKey.get(key);
    if (!byKind) {
      byKind = new Map<WatchInterestKind, Set<string>>();
      this.interestsByKey.set(key, byKind);
    }

    let ids = byKind.get(interest.kind);
    if (!ids) {
      ids = new Set<string>();
      byKind.set(interest.kind, ids);
    }
    ids.add(interest.id);
  }

  remove(key: QuoteKey, interest: WatchInterest): void {
    const byKind = this.interestsByKey.get(key);
    const ids = byKind?.get(interest.kind);
    if (!ids) return;

    ids.delete(interest.id);
    if (ids.size === 0) {
      byKind?.delete(interest.kind);
    }
    if (byKind?.size === 0) {
      this.interestsByKey.delete(key);
    }
  }

  removeAll(key: QuoteKey): void {
    this.interestsByKey.delete(key);
  }

  hasAny(key: QuoteKey): boolean {
    return this.interestsByKey.has(key);
  }

  hasKind(key: QuoteKey, kind: WatchInterestKind): boolean {
    const byKind = this.interestsByKey.get(key);
    return (byKind?.get(kind)?.size ?? 0) > 0;
  }

  operationIds(key: QuoteKey): string[] {
    return Array.from(this.interestsByKey.get(key)?.get('operation') ?? []);
  }

  keysFor(interest: WatchInterest): QuoteKey[] {
    const keys: QuoteKey[] = [];
    for (const [key, byKind] of this.interestsByKey.entries()) {
      if (byKind.get(interest.kind)?.has(interest.id)) {
        keys.push(key);
      }
    }
    return keys;
  }
}

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
  private readonly operationRemovals = new Map<string, Promise<void>>();
  private readonly interests = new MeltQuoteInterestRegistry();
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

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    this.logger?.info('MeltQuoteWatcherService started');

    this.offQuoteUpdated = this.bus.on('melt-quote:updated', async ({ quote }) => {
      try {
        if (this.isActive(generation)) await this.handleCanonicalQuoteUpdate(quote);
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
        if (this.isActive(generation)) await this.stopWatchingMint(mintUrl);
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
    this.logger?.info('MeltQuoteWatcherService stopped');
  }

  /**
   * @internal Declare observation interest synchronously. Return means local acceptance, not
   * subscription readiness or remote acceptance. This watcher owns setup and reports failures.
   * A repeated declaration may retry failed or previously skipped setup; it does not start a loop.
   */
  registerOperationInterest(interest: MeltQuoteOperationInterest): void {
    if (!this.running) return;
    void this.addWatchInterest(interest, { kind: 'operation', id: interest.operationId });
  }

  /** @internal Preserve same-watcher enable retries without retrying successful or untrusted skips. */
  retryFailedOperationInterests(): void {
    if (!this.running) return;
    for (const [key, record] of this.watchRecordByKey) {
      if (record.failed && this.interests.hasKind(key, 'operation')) {
        void this.activateWatchRecord(record, this.getPolicy(record.method));
      }
    }
  }

  /**
   * @internal Withdraw all declarations before returning the cleanup promise. Shared watches stay
   * active; the promise covers only cleanup made necessary by this operation's removal.
   */
  removeOperationInterest(operationId: string): Promise<void> {
    const interest: WatchInterest = { kind: 'operation', id: operationId };
    const cleanup: Promise<void>[] = [];
    const previous = this.operationRemovals.get(operationId);
    if (previous) cleanup.push(previous);
    for (const key of this.interests.keysFor(interest)) {
      this.interests.remove(key, interest);
      if (!this.interests.hasAny(key)) cleanup.push(this.stopWatching(key));
    }
    const task = Promise.all(cleanup).then(() => {});
    this.operationRemovals.set(operationId, task);
    void task.then(() => {
      if (this.operationRemovals.get(operationId) === task)
        this.operationRemovals.delete(operationId);
    });
    return task;
  }

  private isActive(generation: number): boolean {
    return this.running && this.generation === generation;
  }

  private async handleCanonicalQuoteUpdate(quote: MeltQuote): Promise<void> {
    const key = toKey(quote.mintUrl, quote.method, quote.quoteId);

    if (quote.state === 'PAID') {
      await this.stopWatching(key);
      return;
    }

    if (isExpiredMeltQuote(quote)) {
      this.interests.remove(key, CANONICAL_INTEREST);
      if (!this.interests.hasKind(key, 'operation')) {
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
    interest: WatchInterest,
  ): Promise<void> {
    const generation = this.generation;
    for (const quote of quotes) {
      if (!this.isActive(generation)) return;
      await this.addWatchInterest(quote, interest);
    }
  }

  private addWatchInterest(quote: WatchableMeltQuote, interest: WatchInterest): Promise<void> {
    if (!this.running) return Promise.resolve();
    const key = toKey(quote.mintUrl, quote.method, quote.quoteId);
    if (quote.quote?.state === 'PAID') return this.stopWatching(key);
    if (interest.kind === 'canonical' && quote.quote && isExpiredMeltQuote(quote.quote)) {
      this.interests.remove(key, CANONICAL_INTEREST);
      return this.interests.hasKind(key, 'operation') ? Promise.resolve() : this.stopWatching(key);
    }

    const policy = this.getPolicy(quote.method);
    const record = this.ensureWatchRecord(quote, policy);
    this.interests.add(key, interest);
    if (record.start) return record.start;
    if (record.stop) return Promise.resolve();

    return this.activateWatchRecord(record, policy);
  }

  private activateWatchRecord(
    record: QuoteWatchRecord,
    policy: MeltQuoteWatchPolicy,
  ): Promise<void> {
    record.failed = false;
    const task = this.startWatchingRecord(record, policy);
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
      if (!trusted) {
        this.logger?.debug('Skipping melt quote watch for untrusted mint', {
          mintUrl: record.mintUrl,
          quoteId: record.quoteId,
        });
        return;
      }

      const subscription = await this.subs.subscribe(
        record.mintUrl,
        policy.subscriptionKind,
        [record.quoteId],
        async (payload) => {
          await this.handleSubscriptionPayload(record, payload);
        },
      );
      unsubscribe = subscription.unsubscribe;
    } catch (err) {
      if (this.watchRecordByKey.get(key) === record) record.failed = true;
      this.logger?.warn('Failed to start melt quote watch', {
        mintUrl: record.mintUrl,
        method: record.method,
        quoteId: record.quoteId,
        operationIds: this.interests.operationIds(key),
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

      if (quote.state === 'PAID') {
        await this.stopWatching(key);
        return;
      }

      if (isExpiredMeltQuote(quote)) {
        this.interests.remove(key, CANONICAL_INTEREST);
        if (!this.interests.hasKind(key, 'operation')) {
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
    this.interests.removeAll(key);
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

  async stopWatchingMint(mintUrl: string): Promise<void> {
    this.logger?.info('Stopping all melt quote watchers for mint', { mintUrl });
    const prefix = `${mintUrl}::`;
    // Synchronously invalidate every matching record, including acquisitions, before cleanup waits.
    const cleanup = Array.from(this.watchRecordByKey.keys())
      .filter((key) => key.startsWith(prefix))
      .map((key) => this.stopWatching(key));
    for (const [key, retired] of this.retiredByKey) {
      if (key.startsWith(prefix)) cleanup.push(...retired);
    }
    await Promise.all(cleanup);
  }
}
