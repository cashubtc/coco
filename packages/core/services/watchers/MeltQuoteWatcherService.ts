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

type QuoteKey = string;

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
  private stopping?: Promise<void>;
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

  /** Exact recovery permission, not a query about transport presence. */
  hasRecoveryInterest(quote: QuoteWatchIdentity): boolean {
    return this.running && this.interests.hasRecovery(quoteWatchKey(quote));
  }

  private own<T>(work: Promise<T>): Promise<T> {
    this.work.add(work);
    void work.then(
      () => this.work.delete(work),
      () => this.work.delete(work),
    );
    return work;
  }

  async registerInterest(interest: QuoteWatchInterest): Promise<void> {
    await this.own(this.watchMeltQuotes([interest], interest.owner));
  }

  async removeInterest(owner: QuoteWatchOwner): Promise<void> {
    for (const key of this.interests.keysFor(owner)) {
      this.interests.remove(key, owner);
      const record = this.watchRecordByKey.get(key);
      if (!this.interests.hasAny(key)) {
        await this.stopWatching(key);
      } else if (record && !this.interests.hasRecovery(key)) {
        const trusted = await this.mintService.isTrustedMint(record.mintUrl);
        // Registration can add a recovery owner while the trust read is pending.
        if (
          !trusted &&
          !this.interests.hasRecovery(key) &&
          this.watchRecordByKey.get(key) === record
        )
          await this.stopWatching(key);
      }
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    // A concurrent stop wins; a later explicit start can acquire a new set of resources.
    if (this.stopping) {
      await this.stopping;
      return;
    }
    if (this.running) return;
    this.running = true;
    this.logger?.info('MeltQuoteWatcherService started');

    this.offQuoteUpdated = this.bus.on('melt-quote:updated', async ({ quote }) => {
      try {
        await this.own(this.handleCanonicalQuoteUpdate(quote));
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
        await this.own(this.handleMintUntrusted(mintUrl));
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

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.running) return Promise.resolve();
    const stopping = this.stopOwnedResources();
    this.stopping = stopping;
    const finished = () => {
      if (this.stopping === stopping) this.stopping = undefined;
    };
    void stopping.then(finished, finished);
    return stopping;
  }

  private async stopOwnedResources(): Promise<void> {
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
    while (this.work.size) await Promise.allSettled([...this.work]);
    this.interests.clear();
    this.logger?.info('MeltQuoteWatcherService stopped');
  }

  /** @internal Registers future operation-owned interest without wiring operation settlement. */
  async registerOperationInterest(interest: MeltQuoteOperationInterest): Promise<void> {
    await this.own(
      this.watchMeltQuotes(
        [
          {
            mintUrl: interest.mintUrl,
            method: interest.method,
            quoteId: interest.quoteId,
          },
        ],
        { kind: 'operation', id: interest.operationId },
      ),
    );
  }

  /** @internal Removes future operation-owned interest and stops the watch if no interest remains. */
  async removeOperationInterest(operationId: string): Promise<void> {
    await this.removeInterest({ kind: 'operation', id: operationId });
  }

  private async handleCanonicalQuoteUpdate(quote: MeltQuote): Promise<void> {
    if (!this.running) return;
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
    if (!this.running) return;
    if (quotes.length === 0) return;

    for (const input of quotes) {
      if (!this.running) return;
      const quote = { ...input, mintUrl: normalizeMintUrl(input.mintUrl) };
      const key = toKey(quote.mintUrl, quote.method, quote.quoteId);
      this.interests.add(key, interest);
      const canonical =
        quote.quote ??
        (await this.quoteLifecycle.getMeltQuote(quote.mintUrl, quote.method, quote.quoteId));
      if (!this.running) return;
      if (!this.interests.hasAny(key)) continue;
      if (canonical?.state === 'PAID' && Array.isArray(canonical.change)) {
        this.interests.remove(key, CANONICAL_INTEREST);
        await this.stopWatching(key);
        continue;
      }
      if (interest.kind === 'canonical' && quote.quote && isExpiredMeltQuote(quote.quote)) {
        this.interests.remove(key, CANONICAL_INTEREST);
        if (!this.interests.hasAny(key)) {
          await this.stopWatching(key);
        }
        continue;
      }

      const existing = this.watchRecordByKey.get(key);
      if (existing) {
        if (interest.kind !== 'canonical') await existing.start;
        continue;
      }

      const policy = this.getPolicy(quote.method);
      const record = this.ensureWatchRecord(quote, policy);

      record.start = this.own(this.startWatchingRecord(record, policy));
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
      if (!trusted && !this.interests.hasRecovery(key)) {
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
          if (this.running && this.watchRecordByKey.get(key) === record)
            await this.own(this.handleSubscriptionPayload(record, payload));
        },
      );
      unsubscribe = subscription.unsubscribe;
    } catch (err) {
      if (this.watchRecordByKey.get(key) === record) {
        this.removeWatchRecord(key);
      }
      throw err;
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

  private async stopWatching(key: QuoteKey): Promise<void> {
    const record = this.watchRecordByKey.get(key);
    if (!record) {
      return;
    }

    this.removeWatchRecord(key);
    try {
      await record.stop?.();
    } catch (err) {
      this.logger?.warn('Unsubscribe melt quote watcher failed', { key, err });
    }
  }

  private removeWatchRecord(key: QuoteKey): void {
    this.watchRecordByKey.delete(key);
  }

  private async handleMintUntrusted(mintUrl: string): Promise<void> {
    const normalized = normalizeMintUrl(mintUrl);
    const recovery = [...this.watchRecordByKey]
      .filter(([key, record]) => record.mintUrl === normalized && this.interests.hasRecovery(key))
      .map(([, record]) => record);
    // Manager closes all transports on untrust. Retire those stale handles and rebuild
    // only exact recovery observations, including quotes formerly inside a shared batch.
    await this.stopWatchingMint(normalized);
    if (this.running) await this.watchMeltQuotes(recovery, CANONICAL_INTEREST);
  }

  async stopWatchingMint(mintUrl: string): Promise<void> {
    this.logger?.info('Stopping all melt quote watchers for mint', { mintUrl });
    const normalizedMint = normalizeMintUrl(mintUrl);
    const keysToStop: QuoteKey[] = [];

    for (const [key, record] of this.watchRecordByKey) {
      if (record.mintUrl === normalizedMint) {
        keysToStop.push(key);
      }
    }

    for (const key of keysToStop) {
      await this.stopWatching(key);
    }
  }
}
