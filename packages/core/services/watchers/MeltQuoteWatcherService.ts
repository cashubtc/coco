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

function hasFullMeltQuotePayload(method: MeltMethod, payload: unknown): boolean {
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
    if (this.running) return;
    this.running = true;
    this.logger?.info('MeltQuoteWatcherService started');

    this.offQuoteUpdated = this.bus.on('melt-quote:updated', async ({ quote }) => {
      try {
        await this.handleCanonicalQuoteUpdate(quote);
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
        await this.stopWatchingMint(mintUrl);
      } catch (err) {
        this.logger?.error('Failed to stop watching melt quotes on untrust', { mintUrl, err });
      }
    });

    if (this.options.watchExistingPendingQuotesOnStart) {
      try {
        const quotes = await this.quoteLifecycle.getPendingMeltQuotes();
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

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

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

    const keys = Array.from(this.watchRecordByKey.keys());
    for (const key of keys) {
      await this.stopWatching(key);
    }
    this.logger?.info('MeltQuoteWatcherService stopped');
  }

  /** @internal Registers future operation-owned interest without wiring operation settlement. */
  async registerOperationInterest(interest: MeltQuoteOperationInterest): Promise<void> {
    await this.watchMeltQuotes(
      [
        {
          mintUrl: interest.mintUrl,
          method: interest.method,
          quoteId: interest.quoteId,
        },
      ],
      { kind: 'operation', id: interest.operationId },
    );
  }

  /** @internal Removes future operation-owned interest and stops the watch if no interest remains. */
  async removeOperationInterest(operationId: string): Promise<void> {
    const interest: WatchInterest = { kind: 'operation', id: operationId };
    const keys = this.interests.keysFor(interest);
    for (const key of keys) {
      this.interests.remove(key, interest);
      if (!this.interests.hasAny(key)) {
        await this.stopWatching(key);
      }
    }
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
    if (!this.running) return;
    if (quotes.length === 0) return;

    for (const quote of quotes) {
      const key = toKey(quote.mintUrl, quote.method, quote.quoteId);
      if (quote.quote?.state === 'PAID') {
        await this.stopWatching(key);
        continue;
      }
      if (interest.kind === 'canonical' && quote.quote && isExpiredMeltQuote(quote.quote)) {
        this.interests.remove(key, CANONICAL_INTEREST);
        if (!this.interests.hasKind(key, 'operation')) {
          await this.stopWatching(key);
        }
        continue;
      }

      const existing = this.watchRecordByKey.get(key);
      if (existing) {
        this.interests.add(key, interest);
        await existing.start;
        continue;
      }

      const policy = this.getPolicy(quote.method);
      const record = this.ensureWatchRecord(quote, policy);
      this.interests.add(key, interest);

      record.start = this.startWatchingRecord(record, policy);
      try {
        await record.start;
      } finally {
        if (this.watchRecordByKey.get(key) === record) {
          record.start = undefined;
        }
      }
    }
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
      const trusted = await this.mintService.isTrustedMint(record.mintUrl);
      if (!trusted) {
        this.logger?.debug('Skipping melt quote watch for untrusted mint', {
          mintUrl: record.mintUrl,
          quoteId: record.quoteId,
        });
        if (this.watchRecordByKey.get(key) === record) {
          this.removeWatchRecord(key);
        }
        return;
      }

      if (!this.running || this.watchRecordByKey.get(key) !== record) {
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
      if (this.watchRecordByKey.get(key) === record) {
        this.removeWatchRecord(key);
      }
      throw err;
    }

    if (this.watchRecordByKey.get(key) !== record) {
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
    const policy = this.getPolicy(record.method);
    const payloadQuoteId = policy.getPayloadQuoteId(payload);
    if (payloadQuoteId && payloadQuoteId !== record.quoteId) {
      return;
    }

    try {
      const quote = await this.recordSubscriptionObservation(record, payload);
      if (!quote) return;

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

  private async recordSubscriptionObservation(
    record: QuoteWatchRecord,
    payload: unknown,
  ): Promise<MeltQuote | undefined> {
    const policy = this.getPolicy(record.method);

    if (hasFullMeltQuotePayload(record.method, payload) && policy.getPayloadQuoteId(payload)) {
      return this.quoteLifecycle.recordMeltQuoteObservation(
        policy.toCanonicalQuote(
          record.mintUrl,
          payload as MeltMethodQuoteSnapshot<typeof record.method>,
        ),
      );
    }

    const payloadState = isMeltQuoteState(payload) ? payload : this.getObjectPayloadState(payload);
    if (!payloadState) {
      return undefined;
    }

    if (payloadState === 'PAID') {
      return this.quoteLifecycle.refreshMeltQuote(record.mintUrl, record.method, record.quoteId);
    }

    const existing = await this.quoteLifecycle.getMeltQuote(
      record.mintUrl,
      record.method,
      record.quoteId,
    );
    if (!existing) {
      return undefined;
    }

    const now = Date.now();
    return this.quoteLifecycle.recordMeltQuoteObservation({
      ...existing,
      state: payloadState as never,
      lastObservedRemoteState: payloadState as never,
      lastObservedRemoteStateAt: now,
      updatedAt: now,
    } as MeltQuote);
  }

  private getObjectPayloadState(payload: unknown): MeltQuote['state'] | undefined {
    if (typeof payload !== 'object' || payload === null) {
      return undefined;
    }

    const state = (payload as { state?: unknown }).state;
    return isMeltQuoteState(state) ? state : undefined;
  }

  private async stopWatching(key: QuoteKey): Promise<void> {
    const record = this.watchRecordByKey.get(key);
    if (!record) {
      this.interests.removeAll(key);
      return;
    }

    this.removeWatchRecord(key);
    try {
      await record.start;
      await record.stop?.();
    } catch (err) {
      this.logger?.warn('Unsubscribe melt quote watcher failed', { key, err });
    }
  }

  private removeWatchRecord(key: QuoteKey): void {
    this.watchRecordByKey.delete(key);
    this.interests.removeAll(key);
  }

  async stopWatchingMint(mintUrl: string): Promise<void> {
    this.logger?.info('Stopping all melt quote watchers for mint', { mintUrl });
    const prefix = `${mintUrl}::`;
    const keysToStop: QuoteKey[] = [];

    for (const key of this.watchRecordByKey.keys()) {
      if (key.startsWith(prefix)) {
        keysToStop.push(key);
      }
    }

    for (const key of keysToStop) {
      await this.stopWatching(key);
    }
  }
}
