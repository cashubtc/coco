import type { Logger } from '../logging/Logger.ts';
import type { WebSocketFactory } from './WsConnectionManager.ts';
import type { RealTimeTransport } from './RealTimeTransport.ts';
import type { MintAdapter } from './MintAdapter.ts';
import { PollingTransport } from './PollingTransport.ts';
import { HybridTransport } from './HybridTransport.ts';
import { generateSubId } from '../utils.ts';

import type {
  WsRequest,
  WsResponse,
  WsNotification,
  SubscriptionKind,
  UnsubscribeHandler,
} from './SubscriptionProtocol.ts';

export type { UnsubscribeHandler };

export type SubscriptionCallback<TPayload = unknown> = (payload: TPayload) => void | Promise<void>;

export interface SubscriptionManagerOptions {
  /** Slow polling interval while WS is connected (default: 20000ms) */
  slowPollingIntervalMs?: number;
  /** Fast polling interval after WS fails (default: 5000ms) */
  fastPollingIntervalMs?: number;
}

interface ActiveSubscription<TPayload = unknown> {
  subId: string;
  mintUrl: string;
  kind: SubscriptionKind;
  filters: string[];
  callbacks: Set<SubscriptionCallback<TPayload>>;
}

export class SubscriptionManager {
  private readonly nextIdByMint = new Map<string, number>();
  private readonly subscriptions = new Map<string, ActiveSubscription<unknown>>();
  private readonly activeByMint = new Map<string, Set<string>>();
  private readonly pendingSubscribeByMint = new Map<string, Map<number, string>>();
  private readonly transportByMint = new Map<string, RealTimeTransport>();
  private readonly logger?: Logger;
  private readonly messageHandlerByMint = new Map<string, (evt: any) => void>();
  private readonly openHandlerByMint = new Map<string, (evt: any) => void>();
  private readonly hasOpenedByMint = new Map<string, boolean>();
  private readonly wsFactory?: WebSocketFactory;
  private readonly mintAdapter: MintAdapter;
  private readonly options: Required<SubscriptionManagerOptions>;
  private paused = false;

  constructor(
    wsFactoryOrManager: WebSocketFactory | RealTimeTransport,
    mintAdapter: MintAdapter,
    logger?: Logger,
    options?: SubscriptionManagerOptions,
  ) {
    this.logger = logger;
    this.mintAdapter = mintAdapter;
    this.options = {
      slowPollingIntervalMs: options?.slowPollingIntervalMs ?? 20000,
      fastPollingIntervalMs: options?.fastPollingIntervalMs ?? 5000,
    };
    if (typeof wsFactoryOrManager === 'function') {
      this.wsFactory = wsFactoryOrManager;
    } else {
      // Allow direct injection of a transport for tests; use it for all mints
      const injected = wsFactoryOrManager;
      this.transportByMint.set('*', injected);
    }
  }

  /**
   * Get or create a transport for a mint.
   *
   * Uses HybridTransport (WS + polling in parallel) when a wsFactory is available.
   * HybridTransport handles WS failures gracefully by speeding up polling, so we
   * don't need to check mint capabilities or WebSocket availability upfront.
   *
   * Falls back to pure PollingTransport only when no wsFactory is provided.
   */
  private getTransport(mintUrl: string): RealTimeTransport {
    const injected = this.transportByMint.get('*');
    if (injected) return injected;
    let t = this.transportByMint.get(mintUrl);
    if (t) return t;

    if (this.wsFactory) {
      // Use HybridTransport: runs both WS and polling in parallel.
      // If WS fails (no WebSocket in environment, mint doesn't support it, etc.),
      // the transport automatically speeds up polling as a fallback.
      t = new HybridTransport(
        this.wsFactory,
        this.mintAdapter,
        {
          slowPollingIntervalMs: this.options.slowPollingIntervalMs,
          fastPollingIntervalMs: this.options.fastPollingIntervalMs,
        },
        this.logger,
      );
    } else {
      // No wsFactory available, use polling only at fast interval
      t = new PollingTransport(
        this.mintAdapter,
        { intervalMs: this.options.fastPollingIntervalMs },
        this.logger,
      );
    }
    this.transportByMint.set(mintUrl, t);
    return t;
  }

  private getNextId(mintUrl: string): number {
    const current = this.nextIdByMint.get(mintUrl) ?? 0;
    const next = current + 1;
    this.nextIdByMint.set(mintUrl, next);
    return next;
  }

  private ensureMessageListener(mintUrl: string): void {
    if (this.messageHandlerByMint.has(mintUrl)) return;
    const handler = (evt: any) => {
      try {
        const data = typeof evt.data === 'string' ? evt.data : evt.data?.toString?.();
        if (!data) return;
        const parsed = JSON.parse(data) as WsNotification<unknown> | WsResponse;
        this.logger?.debug('Received WS message', {
          mintUrl,
          hasMethod: 'method' in parsed,
          method: 'method' in parsed ? parsed.method : undefined,
          hasId: 'id' in parsed,
          id: 'id' in parsed ? parsed.id : undefined,
          hasResult: 'result' in parsed,
          hasError: 'error' in parsed,
        });
        if ('method' in parsed && parsed.method === 'subscribe') {
          const subId = parsed.params?.subId;
          const active = subId ? this.subscriptions.get(subId) : undefined;
          if (active) {
            for (const cb of active.callbacks) {
              Promise.resolve(cb((parsed as WsNotification<unknown>).params.payload)).catch((err) =>
                this.logger?.error('Subscription callback error', { mintUrl, subId, err }),
              );
            }
          }
        } else if ('error' in parsed && (parsed as WsResponse).error) {
          const resp = parsed as WsResponse;
          const respId = Number((resp as any).id);
          const err = resp.error!;
          const pendingMap = this.pendingSubscribeByMint.get(mintUrl);
          const maybeSubId =
            Number.isFinite(respId) && pendingMap ? pendingMap.get(respId) : undefined;
          if (maybeSubId) {
            this.subscriptions.delete(maybeSubId);
            pendingMap?.delete(respId);
            this.logger?.error('Subscribe request rejected', {
              mintUrl,
              id: resp.id,
              subId: maybeSubId,
              code: err.code,
              message: err.message,
            });
          } else {
            this.logger?.error('WS request error', {
              mintUrl,
              id: resp.id,
              code: err.code,
              message: err.message,
            });
          }
        } else if ('result' in parsed && (parsed as WsResponse).result) {
          const resp = parsed as WsResponse;
          const respId = Number((resp as any).id);
          const pendingMap = this.pendingSubscribeByMint.get(mintUrl);
          if (Number.isFinite(respId) && pendingMap && pendingMap.has(respId)) {
            const subId = pendingMap.get(respId);
            pendingMap.delete(respId);
            this.logger?.info('Subscribe request accepted', {
              mintUrl,
              id: resp.id,
              subId: subId || resp.result?.subId,
            });
          } else {
            // Log unmatched responses for debugging
            this.logger?.debug('Unmatched subscribe response', {
              mintUrl,
              id: resp.id,
              respId,
              hasPendingMap: !!pendingMap,
              pendingMapSize: pendingMap?.size ?? 0,
            });
          }
        }
      } catch (err) {
        this.logger?.error('WS message handling error', { mintUrl, err });
      }
    };
    const t = this.getTransport(mintUrl);
    t.on(mintUrl, 'message', handler);
    this.messageHandlerByMint.set(mintUrl, handler);

    // Also ensure an 'open' listener that re-subscribes active subs on reconnect
    const onOpen = (_evt: any) => {
      try {
        const hasOpened = this.hasOpenedByMint.get(mintUrl) === true;
        if (hasOpened) {
          this.logger?.info('WS open detected, re-subscribing active subscriptions', { mintUrl });
          this.reSubscribeMint(mintUrl);
        } else {
          this.hasOpenedByMint.set(mintUrl, true);
          this.logger?.info('WS open detected, initial open - skipping re-subscribe', { mintUrl });
        }
      } catch (err) {
        this.logger?.error('Failed to handle open event', { mintUrl, err });
      }
    };
    const t2 = this.getTransport(mintUrl);
    t2.on(mintUrl, 'open', onOpen);
    this.openHandlerByMint.set(mintUrl, onOpen);
  }

  async subscribe<TPayload = unknown>(
    mintUrl: string,
    kind: SubscriptionKind,
    filters: string[],
    onNotification?: SubscriptionCallback<TPayload>,
  ): Promise<{ subId: string; unsubscribe: UnsubscribeHandler }> {
    if (!filters || filters.length === 0) {
      throw new Error('filters must be a non-empty array');
    }
    this.ensureMessageListener(mintUrl);

    // Check if there's already an active subscription with the same filters
    // If so, reuse it by adding the callback instead of creating a new subscription
    // Filters are matched by: mintUrl, kind, and sorted filter arrays (order doesn't matter)
    const filtersKey = JSON.stringify([...filters].sort());
    for (const [existingSubId, existingSub] of this.subscriptions.entries()) {
      if (
        existingSub.mintUrl === mintUrl &&
        existingSub.kind === kind &&
        JSON.stringify([...existingSub.filters].sort()) === filtersKey
      ) {
        // Found matching subscription - add callback to it
        if (onNotification) {
          existingSub.callbacks.add(onNotification as unknown as SubscriptionCallback<unknown>);
          this.logger?.debug('Reusing existing subscription', {
            mintUrl,
            kind,
            subId: existingSubId,
            filterCount: filters.length,
          });
        }
        return {
          subId: existingSubId,
          unsubscribe: async () => {
            if (onNotification) {
              this.removeCallback(existingSubId, onNotification);
            }
            // Only unsubscribe if no callbacks remain
            if (existingSub.callbacks.size === 0) {
              await this.unsubscribe(mintUrl, existingSubId);
            }
          },
        };
      }
    }

    // No existing subscription found - create a new one
    const id = this.getNextId(mintUrl);
    const subId = generateSubId();

    const req: WsRequest = {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { kind, subId, filters },
      id,
    };

    const active: ActiveSubscription<unknown> = {
      subId,
      mintUrl,
      kind,
      filters,
      callbacks: new Set<SubscriptionCallback<unknown>>(),
    };
    if (onNotification)
      active.callbacks.add(onNotification as unknown as SubscriptionCallback<unknown>);
    this.subscriptions.set(subId, active);

    // index by mint for reconnect
    let set = this.activeByMint.get(mintUrl);
    if (!set) {
      set = new Set<string>();
      this.activeByMint.set(mintUrl, set);
    }
    set.add(subId);

    // Track pending subscribe by request id so we can handle error responses
    let pendingById = this.pendingSubscribeByMint.get(mintUrl);
    if (!pendingById) {
      pendingById = new Map<number, string>();
      this.pendingSubscribeByMint.set(mintUrl, pendingById);
    }
    pendingById.set(id, subId);

    // If paused, subscription is registered but won't be sent until resume
    if (this.paused) {
      this.logger?.info('Subscription created while paused, will activate on resume', {
        mintUrl,
        kind,
        subId,
      });
      return {
        subId,
        unsubscribe: async () => {
          await this.unsubscribe(mintUrl, subId);
        },
      };
    }

    const t = this.getTransport(mintUrl);
    this.logger?.debug('Sending subscribe request', {
      mintUrl,
      kind,
      subId,
      id,
      filterCount: filters.length,
    });
    t.send(mintUrl, req);
    this.logger?.info('Subscribed to NUT-17', {
      mintUrl,
      kind,
      subId,
      filterCount: filters.length,
    });

    return {
      subId,
      unsubscribe: async () => {
        await this.unsubscribe(mintUrl, subId);
      },
    };
  }

  addCallback<TPayload = unknown>(subId: string, cb: SubscriptionCallback<TPayload>): void {
    const active = this.subscriptions.get(subId);
    if (!active) throw new Error('Subscription not found');
    active.callbacks.add(cb as unknown as SubscriptionCallback<unknown>);
  }

  removeCallback<TPayload = unknown>(subId: string, cb: SubscriptionCallback<TPayload>): void {
    const active = this.subscriptions.get(subId);
    if (!active) return;
    active.callbacks.delete(cb as unknown as SubscriptionCallback<unknown>);
  }

  async unsubscribe(mintUrl: string, subId: string): Promise<void> {
    this.logger?.debug('SubscriptionManager: unsubscribe called', {
      mintUrl,
      subId,
      hasSubscription: this.subscriptions.has(subId),
      activeForMint: this.activeByMint.get(mintUrl)?.size ?? 0,
    });

    const id = this.getNextId(mintUrl);
    const req: WsRequest = {
      jsonrpc: '2.0',
      method: 'unsubscribe',
      params: { subId },
      id,
    };
    const t = this.getTransport(mintUrl);
    this.logger?.debug('SubscriptionManager: sending unsubscribe to transport', {
      mintUrl,
      subId,
      requestId: id,
    });
    t.send(mintUrl, req);
    this.subscriptions.delete(subId);
    const set = this.activeByMint.get(mintUrl);
    set?.delete(subId);
    this.logger?.info('Unsubscribed from NUT-17', {
      mintUrl,
      subId,
      remainingSubscriptions: this.subscriptions.size,
      remainingActiveForMint: set?.size ?? 0,
    });
  }

  closeAll(): void {
    // Close all transports
    const seen = new Set<RealTimeTransport>();
    for (const t of this.transportByMint.values()) {
      if (seen.has(t)) continue;
      seen.add(t);
      t.closeAll();
    }
    this.subscriptions.clear();
    this.activeByMint.clear();
    this.pendingSubscribeByMint.clear();
    this.hasOpenedByMint.clear();
  }

  closeMint(mintUrl: string): void {
    this.logger?.info('Closing all subscriptions for mint', { mintUrl });

    // Get all subscriptions for this mint
    const subIds = this.activeByMint.get(mintUrl);
    if (subIds) {
      for (const subId of subIds) {
        this.subscriptions.delete(subId);
      }
    }

    // Clear all tracking state for this mint
    this.activeByMint.delete(mintUrl);
    this.pendingSubscribeByMint.delete(mintUrl);
    this.nextIdByMint.delete(mintUrl);
    this.messageHandlerByMint.delete(mintUrl);
    this.openHandlerByMint.delete(mintUrl);
    this.hasOpenedByMint.delete(mintUrl);

    // Close transport for this mint
    const transport = this.transportByMint.get(mintUrl);
    if (transport) {
      transport.closeMint(mintUrl);
      this.transportByMint.delete(mintUrl);
    }

    this.logger?.info('SubscriptionManager closed mint', { mintUrl });
  }

  private reSubscribeMint(mintUrl: string): void {
    const set = this.activeByMint.get(mintUrl);
    if (!set || set.size === 0) return;
    // Re-send subscribe requests with the same subId/filters/kind
    for (const subId of set) {
      const active = this.subscriptions.get(subId);
      if (!active) continue;
      const id = this.getNextId(mintUrl);
      const req: WsRequest = {
        jsonrpc: '2.0',
        method: 'subscribe',
        params: { kind: active.kind, subId: active.subId, filters: active.filters },
        id,
      };
      // Track pending subscribe by id to catch errors
      let pendingById = this.pendingSubscribeByMint.get(mintUrl);
      if (!pendingById) {
        pendingById = new Map<number, string>();
        this.pendingSubscribeByMint.set(mintUrl, pendingById);
      }
      pendingById.set(id, subId);
      const t = this.getTransport(mintUrl);
      t.send(mintUrl, req);
      this.logger?.info('Re-subscribed to NUT-17 after reconnect', {
        mintUrl,
        kind: active.kind,
        subId: active.subId,
        filterCount: active.filters.length,
      });
    }
  }

  pause(): void {
    this.paused = true;
    // Pause all transports
    const seen = new Set<RealTimeTransport>();
    for (const t of this.transportByMint.values()) {
      if (seen.has(t)) continue;
      seen.add(t);
      t.pause();
    }
    this.logger?.info('SubscriptionManager paused');
  }

  resume(): void {
    this.paused = false;
    // Resume all transports - they will trigger 'open' events which handle re-subscription
    const seen = new Set<RealTimeTransport>();
    for (const t of this.transportByMint.values()) {
      if (seen.has(t)) continue;
      seen.add(t);
      t.resume();
    }
    // Don't re-subscribe here - the 'open' handler will do it after hasOpened state is set
    this.logger?.info('SubscriptionManager resumed');
  }
}
