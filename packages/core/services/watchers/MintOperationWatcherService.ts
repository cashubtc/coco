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
  failed?: boolean;
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
  private generation = 0;
  private readonly retiredByKey = new Map<QuoteKey, Set<Promise<void>>>();
  private readonly ownerRemovals = new Map<string, Promise<void>>();
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

  /** Declare local ownership immediately; this watcher owns asynchronous activation and errors. */
  registerInterest(interest: QuoteWatchInterest): void {
    if (!this.running) return;
    void this.watchMintQuotes([interest], interest.owner);
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
    const finished = () => {
      if (this.ownerRemovals.get(ownerKey) === task) this.ownerRemovals.delete(ownerKey);
    };
    void task.then(finished, finished);
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
    if (!this.running) return;
    const failed = [...this.watchRecordByKey.values()].filter((record) => record.failed);
    void this.watchMintQuotes(failed, null);
  }

  private isActive(generation: number): boolean {
    return this.running && this.generation === generation;
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
    const generation = ++this.generation;
    this.logger?.info('MintOperationWatcherService started');

    this.offPending = this.bus.on('mint-op:pending', ({ operation }) => {
      if (!this.isActive(generation)) return;
      if (operation.state !== 'pending') return;
      if (!operation.quoteId) return;

      try {
        void this.own(this.watchOperations([operation as PendingMintOperation]));
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
      if (!this.isActive(generation)) return;
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
          if (!this.isActive(generation)) return;
          return this.own(this.removeInterest({ kind: 'operation', id: operationId }));
        }),
      );
    }

    // Stop watching operations when mint is untrusted
    this.offUntrusted = this.bus.on('mint:untrusted', async ({ mintUrl }) => {
      try {
        if (this.isActive(generation))
          await this.own(this.handleMintUntrusted(mintUrl, generation));
      } catch (err) {
        this.logger?.error('Failed to stop watching mint operations on untrust', { mintUrl, err });
      }
    });

    if (this.options.watchExistingPendingOnStart) {
      // Also watch any pending mint operations on startup (only for trusted mints)
      try {
        const pending = await this.mintOperations.getPendingOperations();
        if (!this.isActive(generation)) return;
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
          if (!this.isActive(generation)) return;
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

    if (!this.isActive(generation)) return;
    if (this.options.watchExistingPendingQuotesOnStart) {
      try {
        const quotes = await this.quoteLifecycle.getPendingMintQuotes();
        if (!this.isActive(generation)) return;
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
    for (const key of keys) void this.stopWatching(key);
    while (this.retiredByKey.size) {
      await Promise.all([...this.retiredByKey.values()].flatMap((tasks) => [...tasks]));
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
    owner: QuoteWatchOwner | null = canonicalQuoteOwner,
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
      if (owner) this.interests.add(key, owner);
      const existing = this.watchRecordByKey.get(key);
      if (existing?.start) {
        if (owner?.kind !== 'canonical') starts.add(existing.start);
        continue;
      }
      if (existing?.stop || !this.interests.hasAny(key)) continue;
      const record = this.ensureWatchRecord(quote);
      record.failed = false;
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
        void start.then(() => {
          for (const record of batch) if (record.start === start) record.start = undefined;
        });
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
        const retired = this.retiredByKey.get(key);
        if (retired) await Promise.all([...retired]);
        if (!this.current(record)) continue;
        const trusted = await this.mintService.isTrustedMint(record.mintUrl);
        if (!this.current(record)) continue;
        if (!trusted && !this.interests.hasRecovery(key)) continue;
        const quote = await this.quoteLifecycle.getMintQuote(
          record.mintUrl,
          record.method,
          record.quoteId,
        );
        if (!this.current(record)) continue;
        if (quote && assessMintQuoteClaimability(quote).status === 'complete') {
          this.interests.remove(key, canonicalQuoteOwner);
          // Retire without joining the acquisition currently doing this lookup.
          void this.stopWatching(key);
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
      let stopping: Promise<void> | undefined;
      for (const record of records) {
        record.stop = async () => {
          remaining.delete(record);
          if (!remaining.size) {
            stopping ??= Promise.resolve().then(() => unsubscribe?.());
            await stopping;
          }
        };
      }
      for (const record of records) if (!this.current(record)) await record.stop?.();
    } catch (error) {
      for (const record of batch) {
        if (!this.current(record)) continue;
        record.failed = true;
        this.logger?.warn('Failed to start mint quote watch', {
          mintUrl: record.mintUrl,
          method: record.method,
          quoteId: record.quoteId,
          owners: this.interests.owners(quoteWatchKey(record)),
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
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

  private stopWatching(key: QuoteKey): Promise<void> {
    const record = this.watchRecordByKey.get(key);
    if (!record) return Promise.all([...(this.retiredByKey.get(key) ?? [])]).then(() => {});
    this.watchRecordByKey.delete(key);
    const task = (async () => {
      try {
        await record.start;
        await record.stop?.();
      } catch (err) {
        this.logger?.warn('Unsubscribe mint quote watcher failed', { key, err });
      }
    })();
    const retired = this.retiredByKey.get(key) ?? new Set<Promise<void>>();
    this.retiredByKey.set(key, retired);
    retired.add(task);
    void task.then(() => {
      retired.delete(task);
      if (!retired.size && this.retiredByKey.get(key) === retired) this.retiredByKey.delete(key);
    });
    return task;
  }

  private async handleMintUntrusted(mintUrl: string, generation: number): Promise<void> {
    const normalized = normalizeMintUrl(mintUrl);
    const recovery = [...this.watchRecordByKey.values()].filter(
      (record) =>
        record.mintUrl === normalized && this.interests.hasRecovery(quoteWatchKey(record)),
    );
    // Manager closes the mint transport. Keep logical authorization, retire stale handles,
    // and rebuild only the interests still authorized when cleanup completes.
    await this.stopWatchingMint(normalized);
    if (!this.isActive(generation)) return;
    await this.watchMintQuotes(
      recovery.filter((record) => this.interests.hasRecovery(quoteWatchKey(record))),
      null,
    );
  }

  async stopWatchingMint(mintUrl: string): Promise<void> {
    const prefix = `${normalizeMintUrl(mintUrl)}::`;
    const cleanup = [...this.watchRecordByKey.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => this.stopWatching(key));
    for (const [key, retired] of this.retiredByKey) {
      if (key.startsWith(prefix)) cleanup.push(...retired);
    }
    await Promise.all(cleanup);
  }
}
