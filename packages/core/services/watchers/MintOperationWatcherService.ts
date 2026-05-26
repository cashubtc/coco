import type { EventBus, CoreEvents } from '@core/events';
import type { Logger } from '../../logging/Logger.ts';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import { type MintQuoteBolt11Response, type MintQuoteBolt12Response } from '@cashu/cashu-ts';
import { allocateBolt12PaidMintOperationIds } from '@core/infra/handlers/mint/Bolt12MintQuoteAccounting.ts';
import type { MintService } from '../MintService';
import type { MintMethod, MintOperationService, PendingMintOperation } from '@core/operations/mint';

type QuoteKey = string; // `${mintUrl}::${method}::${quoteId}`

function toKey(mintUrl: string, method: string, quoteId: string): QuoteKey {
  return `${mintUrl}::${method}::${quoteId}`;
}

type ObservedMintState = 'UNPAID' | 'PAID' | 'ISSUED';

export interface MintOperationWatcherOptions {
  // If true, on start() the watcher will also load and watch all pending mint operations
  watchExistingPendingOnStart?: boolean;
}

export class MintOperationWatcherService {
  private readonly subs: SubscriptionManager;
  private readonly mintService: MintService;
  private readonly mintOperations: MintOperationService;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly options: MintOperationWatcherOptions;

  private running = false;
  private unsubscribeByKey = new Map<QuoteKey, UnsubscribeHandler>();
  private operationIdsByKey = new Map<QuoteKey, Set<string>>();
  private keyByOperationId = new Map<string, QuoteKey>();
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
    options: MintOperationWatcherOptions = { watchExistingPendingOnStart: true },
  ) {
    this.subs = subs;
    this.mintService = mintService;
    this.mintOperations = mintOperations;
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
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

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

    const byMint = new Map<string, PendingMintOperation[]>();
    for (const operation of operations) {
      if (!operation.quoteId) continue;
      let group = byMint.get(operation.mintUrl);
      if (!group) {
        group = [];
        byMint.set(operation.mintUrl, group);
      }
      group.push(operation);
    }

    for (const [mintUrl, mintOperations] of byMint.entries()) {
      const trusted = await this.mintService.isTrustedMint(mintUrl);
      if (!trusted) {
        this.logger?.debug('Skipping watch for untrusted mint', { mintUrl });
        continue;
      }

      const newOperationsByKey = new Map<string, PendingMintOperation[]>();
      for (const operation of mintOperations) {
        const key = toKey(mintUrl, operation.method, operation.quoteId);
        if (this.unsubscribeByKey.has(key)) {
          this.trackOperation(key, operation.id);
          continue;
        }

        const operationsForKey = newOperationsByKey.get(key) ?? [];
        operationsForKey.push(operation);
        newOperationsByKey.set(key, operationsForKey);
      }

      const toWatch = Array.from(newOperationsByKey.values(), (operations) => operations[0]!);
      if (toWatch.length === 0) continue;

      const byMethod = new Map<string, PendingMintOperation[]>();
      for (const operation of toWatch) {
        const methodOperations = byMethod.get(operation.method) ?? [];
        methodOperations.push(operation);
        byMethod.set(operation.method, methodOperations);
      }

      for (const [method, methodOperations] of byMethod.entries()) {
        const chunks: PendingMintOperation[][] = [];
        for (let i = 0; i < methodOperations.length; i += 100) {
          chunks.push(methodOperations.slice(i, i + 100));
        }

        for (const batch of chunks) {
          const quoteIds = batch.map((operation) => operation.quoteId);
          const kind = method === 'bolt12' ? 'bolt12_mint_quote' : 'bolt11_mint_quote';

          const { subId, unsubscribe } = await this.subs.subscribe<
            MintQuoteBolt11Response | MintQuoteBolt12Response
          >(mintUrl, kind, quoteIds, async (payload) => {
            const quoteId = payload.quote;
            if (!quoteId) return;
            const key = toKey(mintUrl, method, quoteId);
            const trackedOperationIds = this.operationIdsByKey.get(key);
            if (!trackedOperationIds || trackedOperationIds.size === 0) {
              await this.stopWatching(key);
              return;
            }

            try {
              const operations = await this.mintOperations.getOperationsForQuote(
                mintUrl,
                method as MintMethod,
                quoteId,
              );
              const pendingOperations = operations.filter(
                (operation): operation is PendingMintOperation => operation.state === 'pending',
              );

              if (pendingOperations.length === 0) {
                await this.stopWatching(key);
                return;
              }

              const observedAt = Date.now();
              const statesByOperationId = new Map<string, ObservedMintState>();
              if (method === 'bolt12') {
                const paidOperationIds = allocateBolt12PaidMintOperationIds(
                  payload as MintQuoteBolt12Response,
                  pendingOperations as PendingMintOperation<'bolt12'>[],
                );
                for (const operationId of paidOperationIds) {
                  statesByOperationId.set(operationId, 'PAID');
                }
                for (const current of pendingOperations) {
                  if (
                    !paidOperationIds.has(current.id) &&
                    current.lastObservedRemoteState === 'PAID'
                  ) {
                    statesByOperationId.set(current.id, 'UNPAID');
                  }
                }
              } else {
                const state = (payload as MintQuoteBolt11Response).state;
                if (state === 'PAID' || state === 'ISSUED') {
                  for (const current of pendingOperations) {
                    statesByOperationId.set(current.id, state);
                  }
                }
              }

              for (const current of pendingOperations) {
                const state = statesByOperationId.get(current.id);
                if (!state) continue;

                const observedOperation: PendingMintOperation = {
                  ...current,
                  lastObservedRemoteState: state,
                  lastObservedRemoteStateAt: observedAt,
                  updatedAt: observedAt,
                };

                if (method === 'bolt12' && state === 'UNPAID') {
                  await this.mintOperations.recordPendingObservation(
                    observedOperation.id,
                    state,
                    observedAt,
                  );
                } else {
                  await this.mintOperations.recordQuoteObservation(
                    observedOperation,
                    state,
                    observedAt,
                  );
                }
              }
            } catch (err) {
              this.logger?.error('Failed to persist pending mint quote update from remote update', {
                operationIds: Array.from(trackedOperationIds),
                mintUrl,
                quoteId,
                err,
              });
            }

            if (method !== 'bolt12' && (payload as MintQuoteBolt11Response).state === 'ISSUED') {
              await this.stopWatching(key);
              return;
            }

            await this.stopWatchingIfNoPendingOperations(mintUrl, method, quoteId, key);
          });

          let didUnsubscribe = false;
          const remaining = new Set(
            batch.map((operation) => toKey(mintUrl, method, operation.quoteId)),
          );
          const groupUnsubscribeOnce: UnsubscribeHandler = async () => {
            if (didUnsubscribe) return;
            didUnsubscribe = true;
            await unsubscribe();
          };

          for (const operation of batch) {
            const key = toKey(mintUrl, operation.method, operation.quoteId);
            const operationsForKey = newOperationsByKey.get(key) ?? [operation];
            const perKeyStop: UnsubscribeHandler = async () => {
              if (remaining.has(key)) remaining.delete(key);
              if (remaining.size === 0) {
                await groupUnsubscribeOnce();
              }
            };
            this.unsubscribeByKey.set(key, perKeyStop);
            for (const operationForKey of operationsForKey) {
              this.trackOperation(key, operationForKey.id);
            }
          }

          this.logger?.debug('Watching mint operation batch', {
            mintUrl,
            subId,
            method,
            count: batch.length,
          });
        }
      }
    }
  }

  private trackOperation(key: QuoteKey, operationId: string): void {
    const operationIds = this.operationIdsByKey.get(key) ?? new Set<string>();
    operationIds.add(operationId);
    this.operationIdsByKey.set(key, operationIds);
    this.keyByOperationId.set(operationId, key);
  }

  private async stopWatchingIfNoPendingOperations(
    mintUrl: string,
    method: string,
    quoteId: string,
    key: QuoteKey,
  ): Promise<void> {
    try {
      const operations = await this.mintOperations.getOperationsForQuote(
        mintUrl,
        method as MintMethod,
        quoteId,
      );
      const pendingIds = new Set(
        operations
          .filter((operation) => operation.state === 'pending')
          .map((operation) => operation.id),
      );
      const trackedIds = this.operationIdsByKey.get(key);
      if (trackedIds) {
        for (const operationId of Array.from(trackedIds)) {
          if (!pendingIds.has(operationId)) {
            trackedIds.delete(operationId);
            this.keyByOperationId.delete(operationId);
          }
        }
      }

      if (!trackedIds || trackedIds.size === 0) {
        await this.stopWatching(key);
      }
    } catch (err) {
      this.logger?.warn('Failed to inspect mint operations after remote update', {
        mintUrl,
        quoteId,
        err,
      });
    }
  }

  private async stopWatching(key: QuoteKey): Promise<void> {
    const unsubscribe = this.unsubscribeByKey.get(key);
    if (!unsubscribe) return;
    const operationIds = this.operationIdsByKey.get(key);
    try {
      await unsubscribe();
    } catch (err) {
      this.logger?.warn('Unsubscribe watcher failed', { key, err });
    } finally {
      this.unsubscribeByKey.delete(key);
      this.operationIdsByKey.delete(key);
      for (const operationId of operationIds ?? []) {
        this.keyByOperationId.delete(operationId);
      }
    }
  }

  private async stopWatchingOperation(operationId: string): Promise<void> {
    const key = this.keyByOperationId.get(operationId);
    if (!key) return;
    const operationIds = this.operationIdsByKey.get(key);
    operationIds?.delete(operationId);
    this.keyByOperationId.delete(operationId);
    if (!operationIds || operationIds.size === 0) {
      await this.stopWatching(key);
    }
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
