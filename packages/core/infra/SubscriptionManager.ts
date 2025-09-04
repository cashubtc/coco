import type { Logger } from '../logging/Logger.ts';
import { WsConnectionManager, type WebSocketFactory } from './WsConnectionManager.ts';

type JsonRpcId = number;

type WsRequestMethod = 'subscribe' | 'unsubscribe';

export type SubscriptionKind = 'bolt11_mint_quote' | 'bolt11_melt_quote' | 'proof_state';

export type UnsubscribeHandler = () => Promise<void>;

export interface SubscribeParams {
  kind: SubscriptionKind;
  subId: string;
  filters: string[];
}

export interface UnsubscribeParams {
  subId: string;
}

export type WsRequest = {
  jsonrpc: '2.0';
  method: WsRequestMethod;
  params: SubscribeParams | UnsubscribeParams;
  id: JsonRpcId;
};

export type WsResponse = {
  jsonrpc: '2.0';
  result?: { status: 'OK'; subId: string };
  error?: { code: number; message: string };
  id: JsonRpcId;
};

export type WsNotification<TPayload> = {
  jsonrpc: '2.0';
  method: 'subscribe';
  params: { subId: string; payload: TPayload };
};

// WebSocket types now live in WsConnectionManager

export type SubscriptionCallback<TPayload = unknown> = (payload: TPayload) => void | Promise<void>;

interface ActiveSubscription<TPayload = unknown> {
  subId: string;
  mintUrl: string;
  kind: SubscriptionKind;
  filters: string[];
  callbacks: Set<SubscriptionCallback<TPayload>>;
}

function toBase64Url(bytes: Uint8Array): string {
  let base64: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Buf = (globalThis as any).Buffer;
  if (typeof Buf !== 'undefined') {
    base64 = Buf.from(bytes).toString('base64');
  } else if (typeof btoa !== 'undefined') {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    base64 = btoa(bin);
  }
  if (!base64) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateSubId(): string {
  const length = 16;
  const bytes = new Uint8Array(length);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cryptoObj: any = (globalThis as any).crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return toBase64Url(bytes);
}

export class SubscriptionManager {
  private readonly nextIdByMint = new Map<string, number>();
  private readonly subscriptions = new Map<string, ActiveSubscription<unknown>>();
  private readonly activeByMint = new Map<string, Set<string>>();
  private readonly pendingSubscribeByMint = new Map<string, Map<number, string>>();
  private readonly ws: WsConnectionManager;
  private readonly logger?: Logger;
  private readonly messageHandlerByMint = new Map<string, (evt: any) => void>();
  private readonly openHandlerByMint = new Map<string, (evt: any) => void>();
  private readonly hasOpenedByMint = new Map<string, boolean>();

  constructor(wsFactoryOrManager: WebSocketFactory | WsConnectionManager, logger?: Logger) {
    this.logger = logger;
    this.ws =
      typeof wsFactoryOrManager === 'function'
        ? new WsConnectionManager(wsFactoryOrManager, logger)
        : wsFactoryOrManager;
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
            pendingMap.delete(respId);
            this.logger?.info('Subscribe request accepted', {
              mintUrl,
              id: resp.id,
              subId: resp.result?.subId,
            });
          }
        }
      } catch (err) {
        this.logger?.error('WS message handling error', { mintUrl, err });
      }
    };
    this.ws.on(mintUrl, 'message', handler);
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
    this.ws.on(mintUrl, 'open', onOpen);
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

    this.ws.send(mintUrl, req);
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
    const id = this.getNextId(mintUrl);
    const req: WsRequest = {
      jsonrpc: '2.0',
      method: 'unsubscribe',
      params: { subId },
      id,
    };
    this.ws.send(mintUrl, req);
    this.subscriptions.delete(subId);
    const set = this.activeByMint.get(mintUrl);
    set?.delete(subId);
    this.logger?.info('Unsubscribed from NUT-17', { mintUrl, subId });
  }

  closeAll(): void {
    this.ws.closeAll();
    this.subscriptions.clear();
    this.activeByMint.clear();
    this.pendingSubscribeByMint.clear();
    this.hasOpenedByMint.clear();
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
      this.ws.send(mintUrl, req);
      this.logger?.info('Re-subscribed to NUT-17 after reconnect', {
        mintUrl,
        kind: active.kind,
        subId: active.subId,
        filterCount: active.filters.length,
      });
    }
  }
}
