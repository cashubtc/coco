import type { EventBus, CoreEvents } from '@core/events';
import type { Logger } from '../../logging/Logger.ts';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import type { MintQuoteBolt11Response } from '@cashu/cashu-ts';
import type { MintService } from '../MintService';
import type { MintOperationService, PendingMintOperation } from '@core/operations/mint';
import type { MintQuote } from '../../models/MintQuote.ts';

type QuoteKey = string; // `${mintUrl}::${method}::${quoteId}`

function toKey(mintUrl: string, method: string, quoteId: string): QuoteKey {
  return `${mintUrl}::${method}::${quoteId}`;
}

export interface MintOperationWatcherOptions {
  // If true, on start() the watcher will also load and watch all pending mint operations
  watchExistingPendingOnStart?: boolean;
  // If true, on start() the watcher will also load and watch all pending canonical mint quotes
  watchExistingPendingQuotesOnStart?: boolean;
}

type WatchableMintQuote = Pick<MintQuote<'bolt11'>, 'mintUrl' | 'method' | 'quoteId'>;

export class MintOperationWatcherService {
  private readonly subs: SubscriptionManager;
  private readonly mintService: MintService;
  private readonly mintOperations: MintOperationService;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly options: MintOperationWatcherOptions;

  private running = false;
  private unsubscribeByKey = new Map<QuoteKey, UnsubscribeHandler>();
  private operationIdByKey = new Map<QuoteKey, string>();
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
    bus: EventBus<CoreEvents>,
    logger?: Logger,
    options: MintOperationWatcherOptions = {
      watchExistingPendingOnStart: true,
      watchExistingPendingQuotesOnStart: true,
    },
  ) {
    this.subs = subs;
    this.mintService = mintService;
    this.mintOperations = mintOperations;
    this.bus = bus;
    this.logger = logger;
    this.options = {
      watchExistingPendingOnStart: options.watchExistingPendingOnStart ?? true,
      watchExistingPendingQuotesOnStart: options.watchExistingPendingQuotesOnStart ?? true,
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
      if (quote.method !== 'bolt11') return;

      const key = toKey(quote.mintUrl, quote.method, quote.quoteId);
      if (quote.state === 'ISSUED') {
        await this.stopWatching(key);
        return;
      }

      try {
        await this.watchMintQuotes([quote]);
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
        const quotes = await this.mintOperations.getPendingMintQuotes('bolt11');
        await this.watchMintQuotes(quotes.filter((quote) => quote.method === 'bolt11'));
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

    const keys = Array.from(this.unsubscribeByKey.keys());
    for (const key of keys) {
      await this.stopWatching(key);
    }
    this.logger?.info('MintOperationWatcherService stopped');
  }

  private async watchOperations(operations: PendingMintOperation[]): Promise<void> {
    if (!this.running) return;
    if (operations.length === 0) return;

    const uniqueByQuote = new Map<QuoteKey, WatchableMintQuote>();
    for (const operation of operations) {
      if (!operation.quoteId || operation.method !== 'bolt11') {
        continue;
      }
      const key = toKey(operation.mintUrl, operation.method, operation.quoteId);
      uniqueByQuote.set(key, {
        mintUrl: operation.mintUrl,
        method: operation.method,
        quoteId: operation.quoteId,
      });
      this.linkOperationToQuote(operation.id, key);
    }

    await this.watchMintQuotes(Array.from(uniqueByQuote.values()));
  }

  private async watchMintQuotes(quotes: WatchableMintQuote[]): Promise<void> {
    if (!this.running) return;
    if (quotes.length === 0) return;

    const byMint = new Map<string, WatchableMintQuote[]>();
    for (const quote of quotes) {
      if (quote.method !== 'bolt11') continue;
      const key = toKey(quote.mintUrl, quote.method, quote.quoteId);
      if (this.unsubscribeByKey.has(key)) {
        continue;
      }

      let group = byMint.get(quote.mintUrl);
      if (!group) {
        group = [];
        byMint.set(quote.mintUrl, group);
      }
      group.push(quote);
    }

    for (const [mintUrl, mintQuotes] of byMint.entries()) {
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
        const { subId, unsubscribe } = await this.subs.subscribe<MintQuoteBolt11Response>(
          mintUrl,
          'bolt11_mint_quote',
          quoteIds,
          async (payload) => {
            // Only act on state changes we care about
            if (payload.state !== 'PAID' && payload.state !== 'ISSUED') return;

            const quoteId = payload.quote;
            if (!quoteId) return;
            const key = toKey(mintUrl, 'bolt11', quoteId);

            try {
              await this.mintOperations.recordMintQuoteSnapshot(mintUrl, 'bolt11', payload);
            } catch (err) {
              this.logger?.error('Failed to persist mint quote update from remote update', {
                mintUrl,
                quoteId,
                state: payload.state,
                err,
              });
            }

            if (payload.state === 'ISSUED') {
              await this.stopWatching(key);
              return;
            }
          },
        );

        let didUnsubscribe = false;
        const remaining = new Set(quoteIds);
        const groupUnsubscribeOnce: UnsubscribeHandler = async () => {
          if (didUnsubscribe) return;
          didUnsubscribe = true;
          await unsubscribe();
        };

        for (const quote of batch) {
          const key = toKey(mintUrl, quote.method, quote.quoteId);
          const perKeyStop: UnsubscribeHandler = async () => {
            if (remaining.has(quote.quoteId)) remaining.delete(quote.quoteId);
            if (remaining.size === 0) {
              await groupUnsubscribeOnce();
            }
          };
          this.unsubscribeByKey.set(key, perKeyStop);
        }

        this.logger?.debug('Watching mint quote batch', {
          mintUrl,
          subId,
          count: batch.length,
        });
      }
    }
  }

  private linkOperationToQuote(operationId: string, key: QuoteKey): void {
    this.operationIdByKey.set(key, operationId);
    this.keyByOperationId.set(operationId, key);
  }

  private async stopWatching(key: QuoteKey): Promise<void> {
    const unsubscribe = this.unsubscribeByKey.get(key);
    if (!unsubscribe) return;
    const operationId = this.operationIdByKey.get(key);
    try {
      await unsubscribe();
    } catch (err) {
      this.logger?.warn('Unsubscribe watcher failed', { key, err });
    } finally {
      this.unsubscribeByKey.delete(key);
      this.operationIdByKey.delete(key);
      if (operationId) {
        this.keyByOperationId.delete(operationId);
      }
    }
  }

  private async stopWatchingOperation(operationId: string): Promise<void> {
    const key = this.keyByOperationId.get(operationId);
    if (!key) return;
    await this.stopWatching(key);
  }

  async stopWatchingMint(mintUrl: string): Promise<void> {
    this.logger?.info('Stopping all quote watchers for mint', { mintUrl });
    const prefix = `${mintUrl}::`;
    const keysToStop: QuoteKey[] = [];

    for (const key of this.unsubscribeByKey.keys()) {
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
