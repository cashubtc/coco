import type { EventBus, CoreEvents } from '@core/events';
import type { Logger } from '../../logging/Logger.ts';
import type { MintQuoteRepository } from '../../repositories';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import type { MintQuoteResponse } from '@cashu/cashu-ts';
import type { MintQuoteService } from '../MintQuoteService';

type QuoteKey = string; // `${mintUrl}::${quoteId}`

function toKey(mintUrl: string, quoteId: string): QuoteKey {
  return `${mintUrl}::${quoteId}`;
}

export interface MintQuoteWatcherOptions {
  // If true, on start() the watcher will also load and watch all quotes that are not ISSUED yet
  watchExistingPendingOnStart?: boolean;
}

export class MintQuoteWatcherService {
  private readonly repo: MintQuoteRepository;
  private readonly subs: SubscriptionManager;
  private readonly quotes: MintQuoteService;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly options: MintQuoteWatcherOptions;

  private running = false;
  private unsubscribeByKey = new Map<QuoteKey, UnsubscribeHandler>();
  private offCreated?: () => void;
  private offAdded?: () => void;

  constructor(
    repo: MintQuoteRepository,
    subs: SubscriptionManager,
    quotes: MintQuoteService,
    bus: EventBus<CoreEvents>,
    logger?: Logger,
    options: MintQuoteWatcherOptions = { watchExistingPendingOnStart: true },
  ) {
    this.repo = repo;
    this.subs = subs;
    this.quotes = quotes;
    this.bus = bus;
    this.logger = logger;
    this.options = options;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger?.info('MintQuoteWatcherService started');

    // Subscribe to newly created quotes
    this.offCreated = this.bus.on('mint-quote:created', async ({ mintUrl, quoteId }) => {
      try {
        await this.watchQuote(mintUrl, quoteId);
      } catch (err) {
        this.logger?.error('Failed to start watching quote from event', { mintUrl, quoteId, err });
      }
    });

    // Also watch added quotes that are not in terminal state
    this.offAdded = this.bus.on('mint-quote:added', async ({ mintUrl, quoteId, quote }) => {
      // Only watch if not already in terminal state
      if (quote.state !== 'ISSUED' && quote.state !== 'PAID') {
        try {
          await this.watchQuote(mintUrl, quoteId);
        } catch (err) {
          this.logger?.error('Failed to start watching added quote', {
            mintUrl,
            quoteId,
            state: quote.state,
            err,
          });
        }
      }
    });

    if (this.options.watchExistingPendingOnStart) {
      // Also watch any quotes that are not ISSUED yet
      try {
        const pending = await this.repo.getPendingMintQuotes();
        const byMint = new Map<string, string[]>();
        for (const q of pending) {
          let arr = byMint.get(q.mintUrl);
          if (!arr) {
            arr = [];
            byMint.set(q.mintUrl, arr);
          }
          arr.push(q.quote);
        }
        for (const [mintUrl, quoteIds] of byMint.entries()) {
          try {
            await this.watchQuote(mintUrl, quoteIds);
          } catch (err) {
            this.logger?.warn('Failed to watch pending quotes batch', {
              mintUrl,
              count: quoteIds.length,
              err,
            });
          }
        }
      } catch (err) {
        this.logger?.error('Failed to load pending mint quotes to watch', { err });
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.offCreated) {
      try {
        this.offCreated();
      } catch {
        // ignore
      } finally {
        this.offCreated = undefined;
      }
    }

    if (this.offAdded) {
      try {
        this.offAdded();
      } catch {
        // ignore
      } finally {
        this.offAdded = undefined;
      }
    }

    const entries = Array.from(this.unsubscribeByKey.entries());
    this.unsubscribeByKey.clear();
    for (const [key, unsub] of entries) {
      try {
        await unsub();
        this.logger?.debug('Stopped watching quote', { key });
      } catch (err) {
        this.logger?.warn('Failed to unsubscribe watcher', { key, err });
      }
    }
    this.logger?.info('MintQuoteWatcherService stopped');
  }

  async watchQuote(mintUrl: string, quoteOrQuotes: string | string[]): Promise<void> {
    if (!this.running) return;
    const input = Array.isArray(quoteOrQuotes) ? quoteOrQuotes : [quoteOrQuotes];
    const unique = Array.from(new Set(input));
    // Filter out already-watched
    const toWatch = unique.filter((id) => !this.unsubscribeByKey.has(toKey(mintUrl, id)));
    if (toWatch.length === 0) return;

    // Chunk into batches of 100
    const chunks: string[][] = [];
    for (let i = 0; i < toWatch.length; i += 100) {
      chunks.push(toWatch.slice(i, i + 100));
    }

    for (const batch of chunks) {
      const { subId, unsubscribe } = await this.subs.subscribe<MintQuoteResponse>(
        mintUrl,
        'bolt11_mint_quote',
        batch,
        async (payload) => {
          // Only act on state changes we care about
          if (payload.state !== 'PAID' && payload.state !== 'ISSUED') return;
          const quoteId = payload.quote;
          if (!quoteId) return;
          const key = toKey(mintUrl, quoteId);

          // Update the local state from the remote state
          try {
            await this.quotes.updateStateFromRemote(mintUrl, quoteId, payload.state);
            this.logger?.debug('Updated quote state from remote', {
              mintUrl,
              quoteId,
              state: payload.state,
              subId,
            });
          } catch (err) {
            this.logger?.error('Failed to update quote state from remote', {
              mintUrl,
              quoteId,
              state: payload.state,
              err,
            });
          }

          // Stop watching if the quote reached a terminal state
          if (payload.state === 'ISSUED') {
            await this.stopWatching(key);
          }
        },
      );

      // Per-batch unsubscribe wrapper
      let didUnsubscribe = false;
      const remaining = new Set(batch);
      const groupUnsubscribeOnce: UnsubscribeHandler = async () => {
        if (didUnsubscribe) return;
        didUnsubscribe = true;
        await unsubscribe();
        this.logger?.debug('Unsubscribed watcher for mint quote batch', {
          mintUrl,
          subId,
        });
      };

      // Register per-quote stoppers that shrink the remaining set and
      // unsubscribe the entire batch when the last quote is removed
      for (const quoteId of batch) {
        const key = toKey(mintUrl, quoteId);
        const perKeyStop: UnsubscribeHandler = async () => {
          if (remaining.has(quoteId)) remaining.delete(quoteId);
          if (remaining.size === 0) {
            await groupUnsubscribeOnce();
          }
        };
        this.unsubscribeByKey.set(key, perKeyStop);
      }

      this.logger?.debug('Watching mint quote batch', {
        mintUrl,
        subId,
        filterCount: batch.length,
      });
    }
  }

  private async stopWatching(key: QuoteKey): Promise<void> {
    const unsubscribe = this.unsubscribeByKey.get(key);
    if (!unsubscribe) return;
    try {
      await unsubscribe();
    } catch (err) {
      this.logger?.warn('Unsubscribe watcher failed', { key, err });
    } finally {
      this.unsubscribeByKey.delete(key);
    }
  }
}
