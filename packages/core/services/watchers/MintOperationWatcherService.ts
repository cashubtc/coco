import type { EventBus, CoreEvents } from '@core/events';
import type { Logger } from '../../logging/Logger.ts';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import type { MintService } from '../MintService';
import type {
  BuiltInMintMethod,
  MintMethodQuoteSnapshot,
  MintOperationService,
  PendingMintOperation,
} from '@core/operations/mint';
import type { SubscriptionKind } from '@core/infra/SubscriptionProtocol.ts';
import { mintQuoteToMethodSnapshot, type MintQuote } from '../../models/MintQuote.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';

type QuoteKey = string; // `${mintUrl}::${method}::${quoteId}`

function toKey(mintUrl: string, method: string, quoteId: string): QuoteKey {
  return `${mintUrl}::${method}::${quoteId}`;
}

function isExpiredMintQuoteSnapshot(snapshot: { expiry?: number | null }): boolean {
  return (
    snapshot.expiry !== null &&
    snapshot.expiry !== undefined &&
    snapshot.expiry * 1000 <= Date.now()
  );
}

interface MintQuoteWatchPolicy<M extends BuiltInMintMethod = BuiltInMintMethod> {
  subscriptionKind: SubscriptionKind;
  getPayloadQuoteId(payload: MintMethodQuoteSnapshot<M>): string | undefined;
  shouldRecordPayload(payload: MintMethodQuoteSnapshot<M>): boolean;
  shouldStopWatching(payload: MintMethodQuoteSnapshot<M>): boolean;
  keepWatchingWithoutOperationInterest?: boolean;
}

const mintQuoteWatchPolicies: {
  [M in BuiltInMintMethod]?: MintQuoteWatchPolicy<M>;
} = {
  bolt11: {
    subscriptionKind: 'bolt11_mint_quote',
    getPayloadQuoteId: (payload) => payload.quote,
    shouldRecordPayload: (payload) => payload.state === 'PAID' || payload.state === 'ISSUED',
    shouldStopWatching: (payload) =>
      payload.state === 'ISSUED' || isExpiredMintQuoteSnapshot(payload),
  },
  onchain: {
    subscriptionKind: 'onchain_mint_quote',
    getPayloadQuoteId: (payload) => payload.quote,
    shouldRecordPayload: (payload) =>
      payload.amount_paid !== undefined && payload.amount_issued !== undefined,
    shouldStopWatching: (payload) => isExpiredMintQuoteSnapshot(payload),
    keepWatchingWithoutOperationInterest: true,
  },
  bolt12: {
    subscriptionKind: 'bolt12_mint_quote',
    getPayloadQuoteId: (payload) => payload.quote,
    shouldRecordPayload: (payload) =>
      payload.amount_paid !== undefined && payload.amount_issued !== undefined,
    shouldStopWatching: (payload) => isExpiredMintQuoteSnapshot(payload),
    keepWatchingWithoutOperationInterest: true,
  },
};

export interface MintOperationWatcherOptions {
  // If true, on start() the watcher will also load and watch all pending mint operations
  watchExistingPendingOnStart?: boolean;
  // If true, on start() the watcher will also load and watch all pending canonical mint quotes
  watchExistingPendingQuotesOnStart?: boolean;
}

type WatchableMintQuote<M extends BuiltInMintMethod = BuiltInMintMethod> = Pick<
  MintQuote<M>,
  'mintUrl' | 'method' | 'quoteId'
> & {
  snapshot?: MintMethodQuoteSnapshot<M>;
};

interface WatchMintQuoteInterest {
  canonical?: boolean;
  operationIdsByKey?: Map<QuoteKey, string[]>;
}

interface QuoteWatchRecord {
  mintUrl: string;
  method: BuiltInMintMethod;
  quoteId: string;
  subscriptionKind: SubscriptionKind;
  canonical: boolean;
  operationIds: Set<string>;
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
  private watchRecordByKey = new Map<QuoteKey, QuoteWatchRecord>();
  private keyByOperationId = new Map<string, QuoteKey>();
  private offQuoteUpdated?: () => void;
  private offPending?: () => void;
  private offExecuting?: () => void;
  private offFinalized?: () => void;
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

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger?.info('MintOperationWatcherService started');

    this.offPending = this.bus.on('mint-op:pending', async ({ operation }) => {
      if (operation.state !== 'pending') return;
      if (!operation.quoteId) return;

      try {
        await this.watchOperations([operation as PendingMintOperation]);
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
      const policy = this.getPolicy(quote.method);
      if (!policy) return;

      const snapshot = mintQuoteToMethodSnapshot(quote);
      const key = toKey(quote.mintUrl, quote.method, quote.quoteId);
      if (policy.shouldStopWatching(snapshot)) {
        await this.stopWatching(key);
        return;
      }

      try {
        await this.watchMintQuotes([{ ...quote, snapshot }], { canonical: true });
      } catch (err) {
        this.logger?.error('Failed to start watching canonical mint quote', {
          mintUrl: quote.mintUrl,
          quoteId: quote.quoteId,
          err,
        });
      }
    });

    this.offExecuting = this.bus.on('mint-op:executing', async ({ operationId }) => {
      try {
        await this.stopWatchingOperation(operationId);
      } catch (err) {
        this.logger?.error('Failed to stop watching executing mint operation', {
          operationId,
          err,
        });
      }
    });

    this.offFinalized = this.bus.on('mint-op:finalized', async ({ operationId }) => {
      try {
        await this.stopWatchingOperation(operationId);
      } catch (err) {
        this.logger?.error('Failed to stop watching finalized mint operation', {
          operationId,
          err,
        });
      }
    });

    // Stop watching operations when mint is untrusted
    this.offUntrusted = this.bus.on('mint:untrusted', async ({ mintUrl }) => {
      try {
        await this.stopWatchingMint(mintUrl);
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
        await this.watchMintQuotes(
          quotes.map((quote) => ({
            mintUrl: quote.mintUrl,
            method: quote.method,
            quoteId: quote.quoteId,
            snapshot: mintQuoteToMethodSnapshot(quote),
          })),
          { canonical: true },
        );
      } catch (err) {
        this.logger?.error('Failed to load pending mint quotes to watch', { err });
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
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

    if (this.offExecuting) {
      try {
        this.offExecuting();
      } catch {
        // ignore
      } finally {
        this.offExecuting = undefined;
      }
    }

    if (this.offFinalized) {
      try {
        this.offFinalized();
      } catch {
        // ignore
      } finally {
        this.offFinalized = undefined;
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

    const keys = Array.from(this.watchRecordByKey.keys());
    for (const key of keys) {
      await this.stopWatching(key);
    }
    this.logger?.info('MintOperationWatcherService stopped');
  }

  private async watchOperations(operations: PendingMintOperation[]): Promise<void> {
    if (!this.running) return;
    if (operations.length === 0) return;

    const uniqueByQuote = new Map<QuoteKey, WatchableMintQuote>();
    const operationIdsByKey = new Map<QuoteKey, string[]>();
    for (const operation of operations) {
      if (!operation.quoteId || !this.getPolicy(operation.method)) {
        continue;
      }
      const key = toKey(operation.mintUrl, operation.method, operation.quoteId);
      uniqueByQuote.set(key, {
        mintUrl: operation.mintUrl,
        method: operation.method,
        quoteId: operation.quoteId,
      });
      const operationIds = operationIdsByKey.get(key) ?? [];
      operationIds.push(operation.id);
      operationIdsByKey.set(key, operationIds);
    }

    await this.watchMintQuotes(Array.from(uniqueByQuote.values()), { operationIdsByKey });
  }

  private async watchMintQuotes(
    quotes: WatchableMintQuote[],
    interest: WatchMintQuoteInterest,
  ): Promise<void> {
    if (!this.running) return;
    if (quotes.length === 0) return;

    const byGroup = new Map<string, WatchableMintQuote[]>();
    for (const quote of quotes) {
      const policy = this.getPolicy(quote.method);
      if (!policy) continue;

      const key = toKey(quote.mintUrl, quote.method, quote.quoteId);
      if (quote.snapshot && policy.shouldStopWatching(quote.snapshot)) {
        await this.stopWatching(key);
        continue;
      }

      const existing = this.watchRecordByKey.get(key);
      if (existing?.stop) {
        this.addInterest(existing, key, interest);
        continue;
      }

      const groupKey = `${quote.mintUrl}::${policy.subscriptionKind}`;
      let group = byGroup.get(groupKey);
      if (!group) {
        group = [];
        byGroup.set(groupKey, group);
      }
      group.push(quote);
    }

    for (const mintQuotes of byGroup.values()) {
      const first = mintQuotes[0];
      if (!first) continue;

      const mintUrl = first.mintUrl;
      const policy = this.getPolicy(first.method);
      if (!policy) continue;

      const trusted = await this.mintService.isTrustedMint(mintUrl);
      if (!trusted) {
        this.logger?.debug('Skipping watch for untrusted mint', { mintUrl });
        continue;
      }

      const chunks: WatchableMintQuote[][] = [];
      for (let i = 0; i < mintQuotes.length; i += 100) {
        chunks.push(mintQuotes.slice(i, i + 100));
      }

      for (const batch of chunks) {
        const quoteIds = batch.map((quote) => quote.quoteId);
        const records: QuoteWatchRecord[] = [];
        for (const quote of batch) {
          const record = this.ensureWatchRecord(quote);
          this.addInterest(record, toKey(quote.mintUrl, quote.method, quote.quoteId), interest);
          records.push(record);
        }

        let unsubscribe: UnsubscribeHandler | undefined;
        let subId: string | undefined;
        try {
          const subscription = await this.subs.subscribe<MintMethodQuoteSnapshot>(
            mintUrl,
            policy.subscriptionKind,
            quoteIds,
            async (payload) => {
              await this.handleSubscriptionPayload(mintUrl, policy.subscriptionKind, payload);
            },
          );
          subId = subscription.subId;
          unsubscribe = subscription.unsubscribe;
        } catch (err) {
          for (const record of records) {
            this.removeWatchRecord(toKey(record.mintUrl, record.method, record.quoteId));
          }
          throw err;
        }

        let didUnsubscribe = false;
        const remaining = new Set(quoteIds);
        const groupUnsubscribeOnce: UnsubscribeHandler = async () => {
          if (didUnsubscribe) return;
          didUnsubscribe = true;
          await unsubscribe?.();
        };

        for (const record of records) {
          const key = toKey(record.mintUrl, record.method, record.quoteId);
          const perKeyStop: UnsubscribeHandler = async () => {
            if (remaining.has(record.quoteId)) remaining.delete(record.quoteId);
            if (remaining.size === 0) {
              await groupUnsubscribeOnce();
            }
          };
          record.stop = perKeyStop;
        }

        this.logger?.debug('Watching mint quote batch', {
          mintUrl,
          subId,
          count: batch.length,
        });
      }
    }
  }

  private getPolicy<M extends BuiltInMintMethod>(method: M): MintQuoteWatchPolicy<M> | undefined {
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
        canonical: false,
        operationIds: new Set<string>(),
      };
      this.watchRecordByKey.set(key, record);
    }

    return record;
  }

  private addInterest(
    record: QuoteWatchRecord,
    key: QuoteKey,
    interest: WatchMintQuoteInterest,
  ): void {
    if (interest.canonical) {
      record.canonical = true;
    }

    const operationIds = interest.operationIdsByKey?.get(key) ?? [];
    for (const operationId of operationIds) {
      record.operationIds.add(operationId);
      this.keyByOperationId.set(operationId, key);
    }
  }

  private async handleSubscriptionPayload(
    mintUrl: string,
    subscriptionKind: SubscriptionKind,
    payload: MintMethodQuoteSnapshot,
  ): Promise<void> {
    const record = this.findRecordForPayload(mintUrl, subscriptionKind, payload);
    if (!record) return;

    const policy = this.getPolicy(record.method);
    if (!policy) return;

    const methodPayload = payload as MintMethodQuoteSnapshot<typeof record.method>;
    const quoteId = policy.getPayloadQuoteId(methodPayload);
    if (!quoteId) return;

    const key = toKey(mintUrl, record.method, quoteId);
    if (policy.shouldRecordPayload(methodPayload)) {
      try {
        await this.quoteLifecycle.recordMintQuoteSnapshot(mintUrl, record.method, methodPayload);
      } catch (err) {
        this.logger?.error('Failed to persist mint quote update from remote update', {
          mintUrl,
          quoteId,
          method: record.method,
          err,
        });
      }
    }

    if (policy.shouldStopWatching(methodPayload)) {
      await this.stopWatching(key);
    }
  }

  private findRecordForPayload(
    mintUrl: string,
    subscriptionKind: SubscriptionKind,
    payload: MintMethodQuoteSnapshot,
  ): QuoteWatchRecord | undefined {
    for (const record of this.watchRecordByKey.values()) {
      if (record.mintUrl !== mintUrl || record.subscriptionKind !== subscriptionKind) {
        continue;
      }

      const policy = this.getPolicy(record.method);
      const quoteId = policy?.getPayloadQuoteId(
        payload as MintMethodQuoteSnapshot<typeof record.method>,
      );
      if (quoteId === record.quoteId) {
        return record;
      }
    }

    return undefined;
  }

  private async stopWatching(key: QuoteKey): Promise<void> {
    const record = this.watchRecordByKey.get(key);
    if (!record) return;
    try {
      await record.stop?.();
    } catch (err) {
      this.logger?.warn('Unsubscribe watcher failed', { key, err });
    } finally {
      this.removeWatchRecord(key);
    }
  }

  private async stopWatchingOperation(operationId: string): Promise<void> {
    const key = this.keyByOperationId.get(operationId);
    if (!key) return;
    const record = this.watchRecordByKey.get(key);
    this.keyByOperationId.delete(operationId);
    if (!record) return;

    record.operationIds.delete(operationId);
    if (this.shouldStopWatchingWithoutInterest(record)) {
      await this.stopWatching(key);
    }
  }

  private shouldStopWatchingWithoutInterest(record: QuoteWatchRecord): boolean {
    if (record.canonical || record.operationIds.size > 0) {
      return false;
    }

    return this.getPolicy(record.method)?.keepWatchingWithoutOperationInterest !== true;
  }

  private removeWatchRecord(key: QuoteKey): void {
    const record = this.watchRecordByKey.get(key);
    if (!record) return;

    for (const operationId of record.operationIds) {
      if (this.keyByOperationId.get(operationId) === key) {
        this.keyByOperationId.delete(operationId);
      }
    }

    this.watchRecordByKey.delete(key);
  }

  async stopWatchingMint(mintUrl: string): Promise<void> {
    this.logger?.info('Stopping all quote watchers for mint', { mintUrl });
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

    this.logger?.info('Stopped quote watchers for mint', { mintUrl, count: keysToStop.length });
  }
}
