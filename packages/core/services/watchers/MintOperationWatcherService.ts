import type { EventBus, CoreEvents } from '@core/events';
import type { Logger } from '../../logging/Logger.ts';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import type { MintService } from '../MintService';
import type {
  MintMethod,
  MintMethodQuoteSnapshot,
  MintOperationService,
  PendingMintOperation,
} from '@core/operations/mint';
import type { SubscriptionKind } from '@core/infra/SubscriptionProtocol.ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import { assessMintQuoteClaimability } from '../../models/MintQuoteClaimability.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
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

function toKey(mintUrl: string, method: string, quoteId: string): QuoteKey {
  return quoteWatchKey({ mintUrl, method: method as MintMethod, quoteId });
}

interface MintQuoteWatchPolicy<M extends MintMethod = MintMethod> {
  subscriptionKind: SubscriptionKind;
  getPayloadQuoteId(payload: MintMethodQuoteSnapshot<M>): string | undefined;
}

const mintQuoteWatchPolicies: {
  [M in MintMethod]?: MintQuoteWatchPolicy<M>;
} = {
  bolt11: {
    subscriptionKind: 'bolt11_mint_quote',
    getPayloadQuoteId: (payload) => payload.quote,
  },
  onchain: {
    subscriptionKind: 'onchain_mint_quote',
    getPayloadQuoteId: (payload) => payload.quote,
  },
  bolt12: {
    subscriptionKind: 'bolt12_mint_quote',
    getPayloadQuoteId: (payload) => payload.quote,
  },
};

export interface MintOperationWatcherOptions {
  // If true, on start() the watcher will also load and watch all pending mint operations
  watchExistingPendingOnStart?: boolean;
  // If true, on start() the watcher will also load and watch all pending canonical mint quotes
  watchExistingPendingQuotesOnStart?: boolean;
}

type WatchableMintQuote<M extends MintMethod = MintMethod> = Pick<
  MintQuote<M>,
  'mintUrl' | 'method' | 'quoteId'
>;

interface QuoteWatchRecord {
  mintUrl: string;
  method: MintMethod;
  quoteId: string;
  subscriptionKind: SubscriptionKind;
  start?: Promise<void>;
  stop?: UnsubscribeHandler;
}

export class MintOperationWatcherService {
  private readonly subs: SubscriptionManager;
  private readonly mintService: MintService;
  private readonly mintOperations: MintOperationService;
  private readonly quoteLifecycle: QuoteLifecycle;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly options: MintOperationWatcherOptions;

  private running = false;
  private stopping?: Promise<void>;
  private readonly interests = new QuoteWatchInterests();
  private readonly work = new Set<Promise<unknown>>();
  private watchRecordByKey = new Map<QuoteKey, QuoteWatchRecord>();
  private offQuoteUpdated?: () => void;
  private offPending?: () => void;
  private offEnded: Array<() => void> = [];
  private offUntrusted?: () => void;

  constructor(
    subs: SubscriptionManager,
    mintService: MintService,
    mintOperations: MintOperationService,
    quoteLifecycle: QuoteLifecycle,
    bus: EventBus<CoreEvents>,
    logger?: Logger,
    options?: MintOperationWatcherOptions,
  ) {
    this.subs = subs;
    this.mintService = mintService;
    this.mintOperations = mintOperations;
    this.quoteLifecycle = quoteLifecycle;
    this.bus = bus;
    this.logger = logger;
    this.options = {
      watchExistingPendingOnStart: options?.watchExistingPendingOnStart ?? true,
      watchExistingPendingQuotesOnStart: options?.watchExistingPendingQuotesOnStart ?? true,
    };
  }

  /** Exact recovery permission used by shared polling as well as watcher admission. */
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
    await this.own(this.watchMintQuotes([interest], interest.owner));
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
    this.logger?.info('MintOperationWatcherService started');

    this.offPending = this.bus.on('mint-op:pending', async ({ operation }) => {
      if (!this.running) return;
      if (operation.state !== 'pending') return;
      if (!operation.quoteId) return;

      try {
        await this.own(this.watchOperations([operation as PendingMintOperation]));
      } catch (err) {
        this.logger?.error('Failed to start watching pending mint operation', {
          operationId: operation.id,
          mintUrl: operation.mintUrl,
          quoteId: operation.quoteId,
          err,
        });
      }
    });

    this.offQuoteUpdated = this.bus.on('mint-quote:updated', async ({ quote }) => {
      if (!this.running) return;
      const policy = this.getPolicy(quote.method);
      if (!policy) return;

      const key = toKey(quote.mintUrl, quote.method, quote.quoteId);
      if (assessMintQuoteClaimability(quote).status === 'complete') {
        this.interests.remove(key, canonicalQuoteOwner);
        await this.own(this.stopWatching(key));
        return;
      }

      try {
        await this.own(this.watchMintQuotes([quote]));
      } catch (err) {
        this.logger?.error('Failed to start watching canonical mint quote', {
          mintUrl: quote.mintUrl,
          quoteId: quote.quoteId,
          err,
        });
      }
    });

    for (const event of ['mint-op:finalized', 'mint-op:failed'] as const) {
      this.offEnded.push(
        this.bus.on(event, ({ operationId }) => {
          if (!this.running) return;
          return this.own(this.removeInterest({ kind: 'operation', id: operationId }));
        }),
      );
    }

    // Stop watching operations when mint is untrusted
    this.offUntrusted = this.bus.on('mint:untrusted', async ({ mintUrl }) => {
      try {
        await this.own(this.handleMintUntrusted(mintUrl));
      } catch (err) {
        this.logger?.error('Failed to stop watching mint operations on untrust', { mintUrl, err });
      }
    });

    if (this.options.watchExistingPendingOnStart) {
      // Also watch any pending mint operations on startup (only for trusted mints)
      try {
        const pending = await this.mintOperations.getPendingOperations();
        const byMint = new Map<string, PendingMintOperation[]>();
        for (const operation of pending) {
          if (!operation.quoteId) continue;
          let arr = byMint.get(operation.mintUrl);
          if (!arr) {
            arr = [];
            byMint.set(operation.mintUrl, arr);
          }
          arr.push(operation);
        }
        for (const [mintUrl, operations] of byMint.entries()) {
          const trusted = await this.mintService.isTrustedMint(mintUrl);
          if (!trusted) {
            this.logger?.debug('Skipping pending mint operations for untrusted mint', {
              mintUrl,
              count: operations.length,
            });
            continue;
          }

          try {
            await this.watchOperations(operations);
          } catch (err) {
            this.logger?.warn('Failed to watch pending mint operation batch', {
              mintUrl,
              count: operations.length,
              err,
            });
          }
        }
      } catch (err) {
        this.logger?.error('Failed to load pending mint operations to watch', { err });
      }
    }

    if (this.options.watchExistingPendingQuotesOnStart) {
      try {
        const quotes = await this.quoteLifecycle.getPendingMintQuotes();
        await this.watchMintQuotes(quotes);
      } catch (err) {
        this.logger?.error('Failed to load pending mint quotes to watch', { err });
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
      } catch {
        // ignore
      } finally {
        this.offQuoteUpdated = undefined;
      }
    }

    if (this.offPending) {
      try {
        this.offPending();
      } catch {
        // ignore
      } finally {
        this.offPending = undefined;
      }
    }

    if (this.offUntrusted) {
      try {
        this.offUntrusted();
      } catch {
        // ignore
      } finally {
        this.offUntrusted = undefined;
      }
    }

    for (const off of this.offEnded) off();
    this.offEnded = [];
    const keys = Array.from(this.watchRecordByKey.keys());
    for (const key of keys) {
      await this.stopWatching(key);
    }
    while (this.work.size) await Promise.allSettled([...this.work]);
    this.interests.clear();
    this.logger?.info('MintOperationWatcherService stopped');
  }

  private async watchOperations(operations: PendingMintOperation[]): Promise<void> {
    if (!this.running) return;
    for (const operation of operations) {
      this.interests.add(toKey(operation.mintUrl, operation.method, operation.quoteId), {
        kind: 'operation',
        id: operation.id,
      });
    }
    await this.watchMintQuotes(operations);
  }

  private async watchMintQuotes(
    quotes: WatchableMintQuote[],
    owner: QuoteWatchOwner = canonicalQuoteOwner,
  ): Promise<void> {
    if (!this.running) return;
    const groups = new Map<string, QuoteWatchRecord[]>();
    const starts = new Set<Promise<void>>();
    // Reserve records before any await so concurrent owners join the same batch/startup.
    for (const input of quotes) {
      const quote = { ...input, mintUrl: normalizeMintUrl(input.mintUrl) };
      const policy = this.getPolicy(quote.method);
      if (!policy) continue;
      const key = toKey(quote.mintUrl, quote.method, quote.quoteId);
      this.interests.add(key, owner);
      const existing = this.watchRecordByKey.get(key);
      if (existing) {
        if (existing.start && owner.kind !== 'canonical') starts.add(existing.start);
        continue;
      }
      const record = this.ensureWatchRecord(quote);
      const groupKey = `${quote.mintUrl}::${policy.subscriptionKind}`;
      let group = groups.get(groupKey);
      if (!group) groups.set(groupKey, (group = []));
      group.push(record);
    }
    for (const group of groups.values()) {
      for (let index = 0; index < group.length; index += 100) {
        const batch = group.slice(index, index + 100);
        const start = this.own(Promise.resolve().then(() => this.startBatch(batch)));
        for (const record of batch) record.start = start;
        starts.add(start);
      }
    }
    await Promise.all(starts);
  }

  private current(record: QuoteWatchRecord): boolean {
    return (
      this.running &&
      this.watchRecordByKey.get(toKey(record.mintUrl, record.method, record.quoteId)) === record
    );
  }

  private async startBatch(batch: QuoteWatchRecord[]): Promise<void> {
    let unsubscribe: UnsubscribeHandler | undefined;
    const active: QuoteWatchRecord[] = [];
    try {
      for (const record of batch) {
        if (!this.current(record)) continue;
        const key = toKey(record.mintUrl, record.method, record.quoteId);
        const trusted = await this.mintService.isTrustedMint(record.mintUrl);
        if (!this.current(record)) continue;
        if (!trusted && !this.interests.hasRecovery(key)) {
          await this.stopWatching(key);
          continue;
        }
        const quote = await this.quoteLifecycle.getMintQuote(
          record.mintUrl,
          record.method,
          record.quoteId,
        );
        if (!this.current(record)) continue;
        if (quote && assessMintQuoteClaimability(quote).status === 'complete') {
          this.interests.remove(key, canonicalQuoteOwner);
          await this.stopWatching(key);
          continue;
        }
        active.push(record);
      }
      const records = active.filter((record) => this.current(record));
      if (!records.length) return;
      const first = records[0]!;
      const subscription = await this.subs.subscribe<MintMethodQuoteSnapshot>(
        first.mintUrl,
        first.subscriptionKind,
        records.map((record) => record.quoteId),
        async (payload) => {
          const record = records.find(
            (candidate) =>
              this.current(candidate) &&
              this.getPolicy(candidate.method)?.getPayloadQuoteId(payload as never) ===
                candidate.quoteId,
          );
          if (record) await this.own(this.handleSubscriptionPayload(record, payload));
        },
      );
      unsubscribe = subscription.unsubscribe;
      const remaining = new Set(records);
      let stopped = false;
      for (const record of records) {
        record.stop = async () => {
          remaining.delete(record);
          if (!remaining.size && !stopped) {
            stopped = true;
            await unsubscribe?.();
          }
        };
      }
      for (const record of records) if (!this.current(record)) await record.stop?.();
    } catch (error) {
      for (const record of batch) {
        if (this.current(record))
          await this.stopWatching(toKey(record.mintUrl, record.method, record.quoteId));
      }
      throw error;
    } finally {
      for (const record of batch) record.start = undefined;
    }
  }

  private getPolicy<M extends MintMethod>(method: M): MintQuoteWatchPolicy<M> | undefined {
    return mintQuoteWatchPolicies[method] as MintQuoteWatchPolicy<M> | undefined;
  }

  private ensureWatchRecord(quote: WatchableMintQuote): QuoteWatchRecord {
    const policy = this.getPolicy(quote.method);
    if (!policy) {
      throw new Error(`No mint quote watch policy for method ${quote.method}`);
    }

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

  private async handleSubscriptionPayload(
    record: QuoteWatchRecord,
    payload: MintMethodQuoteSnapshot,
  ): Promise<void> {
    if (!this.current(record)) return;
    try {
      const quote = await this.quoteLifecycle.recordMintQuoteSnapshot(
        record.mintUrl,
        record.method,
        payload,
      );
      if (this.current(record) && assessMintQuoteClaimability(quote).status === 'complete') {
        this.interests.remove(quoteWatchKey(record), canonicalQuoteOwner);
        await this.stopWatching(toKey(record.mintUrl, record.method, record.quoteId));
      }
    } catch (error) {
      this.logger?.error('Failed to persist mint quote update from remote update', {
        mintUrl: record.mintUrl,
        method: record.method,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private async stopWatching(key: QuoteKey): Promise<void> {
    const record = this.watchRecordByKey.get(key);
    if (!record) return;
    this.watchRecordByKey.delete(key);
    try {
      await record.stop?.();
    } catch (err) {
      this.logger?.warn('Unsubscribe watcher failed', { key, err });
    }
  }

  private async handleMintUntrusted(mintUrl: string): Promise<void> {
    const normalized = normalizeMintUrl(mintUrl);
    const recovery = [...this.watchRecordByKey]
      .filter(([key, record]) => record.mintUrl === normalized && this.interests.hasRecovery(key))
      .map(([, record]) => record);
    // Manager closes all transports on untrust. Retire those stale handles and rebuild
    // only exact recovery observations, including quotes formerly inside a shared batch.
    await this.stopWatchingMint(normalized);
    if (this.running) await this.watchMintQuotes(recovery);
  }

  async stopWatchingMint(mintUrl: string): Promise<void> {
    this.logger?.info('Stopping all quote watchers for mint', { mintUrl });
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

    this.logger?.info('Stopped quote watchers for mint', { mintUrl, count: keysToStop.length });
  }
}
