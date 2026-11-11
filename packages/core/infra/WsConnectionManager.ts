import type { Logger } from '../logging/Logger.ts';
import type { TransportEvent } from './RealTimeTransport.ts';

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: TransportEvent, listener: (event: any) => void): void;
  removeEventListener(type: TransportEvent, listener: (event: any) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WsConnectionManagerOptions {
  /** Disable automatic reconnect when polling handles failures. Default: false. */
  disableReconnect?: boolean;
}

type Connection = { socket: WebSocketLike; open: boolean };

export class WsConnectionManager {
  private readonly connections = new Map<string, Connection>();
  private readonly listenersByMint = new Map<
    string,
    Map<TransportEvent, Set<(event: any) => void>>
  >();
  private readonly reconnectAttemptsByMint = new Map<string, number>();
  private readonly reconnectTimeoutByMint = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly wsFactory: WebSocketFactory,
    private readonly logger?: Logger,
    private readonly options: WsConnectionManagerOptions = {},
  ) {}

  private buildWsUrl(baseMintUrl: string): string {
    const url = new URL(baseMintUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    url.pathname = `${path}/v1/ws`;
    return url.toString();
  }

  private ensureSocket(mintUrl: string): void {
    if (this.connections.has(mintUrl)) return;
    try {
      const socket = this.wsFactory(this.buildWsUrl(mintUrl));
      const connection: Connection = { socket, open: false };
      this.connections.set(mintUrl, connection);
      for (const event of ['open', 'message', 'error', 'close'] as const) {
        socket.addEventListener(event, (evt) => {
          // OS teardown and explicit repair may deliver callbacks long after replacement.
          if (this.connections.get(mintUrl) !== connection) return;
          if (event === 'open') {
            if (connection.open) return;
            connection.open = true;
            this.clearReconnect(mintUrl);
          } else if (event === 'close') {
            this.connections.delete(mintUrl);
          }
          for (const listener of this.listenersByMint.get(mintUrl)?.get(event) ?? []) {
            listener(evt);
          }
          if (event === 'close' && !this.connections.has(mintUrl)) {
            this.scheduleReconnect(mintUrl);
          }
        });
      }
    } catch (err) {
      // Offline/factory failures must leave polling and future repair available.
      this.logger?.warn('Failed to create WS connection', { mintUrl, err });
      this.scheduleReconnect(mintUrl);
    }
  }

  private scheduleReconnect(mintUrl: string): void {
    if (
      this.options.disableReconnect ||
      this.reconnectTimeoutByMint.has(mintUrl) ||
      !this.listenersByMint.has(mintUrl)
    )
      return;
    const attempt = (this.reconnectAttemptsByMint.get(mintUrl) ?? 0) + 1;
    this.reconnectAttemptsByMint.set(mintUrl, attempt);
    const delayMs = Math.min(30000, 1000 * 2 ** Math.min(6, attempt - 1));
    const timer = setTimeout(() => {
      if (this.reconnectTimeoutByMint.get(mintUrl) !== timer) return;
      this.reconnectTimeoutByMint.delete(mintUrl);
      this.ensureSocket(mintUrl);
    }, delayMs);
    this.reconnectTimeoutByMint.set(mintUrl, timer);
  }

  on(mintUrl: string, event: TransportEvent, listener: (event: any) => void): void {
    let map = this.listenersByMint.get(mintUrl);
    if (!map) {
      map = new Map();
      this.listenersByMint.set(mintUrl, map);
    }
    let listeners = map.get(event);
    if (!listeners) {
      listeners = new Set();
      map.set(event, listeners);
    }
    listeners.add(listener);
    this.ensureSocket(mintUrl);
  }

  off(mintUrl: string, event: TransportEvent, listener: (event: any) => void): void {
    this.listenersByMint.get(mintUrl)?.get(event)?.delete(listener);
  }

  /** The open listener replays current subscriptions; never queue stale wire interests. */
  send(mintUrl: string, message: unknown): void {
    const connection = this.connections.get(mintUrl);
    if (!connection?.open) return;
    try {
      connection.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    } catch (err) {
      this.logger?.error('WS send error', { mintUrl, err });
    }
  }

  private clearReconnect(mintUrl: string): void {
    const timer = this.reconnectTimeoutByMint.get(mintUrl);
    if (timer !== undefined) clearTimeout(timer);
    this.reconnectTimeoutByMint.delete(mintUrl);
    this.reconnectAttemptsByMint.delete(mintUrl);
  }

  private retireConnection(mintUrl: string): void {
    this.clearReconnect(mintUrl);
    const connection = this.connections.get(mintUrl);
    // Fence synchronous close callbacks too, before touching the external socket.
    this.connections.delete(mintUrl);
    try {
      connection?.socket.close(1000, 'Connection retired');
    } catch (err) {
      this.logger?.warn('Error while closing WS', { mintUrl, err });
    }
  }

  closeMint(mintUrl: string): void {
    this.listenersByMint.delete(mintUrl);
    this.retireConnection(mintUrl);
  }

  closeAll(): void {
    const mints = new Set([...this.connections.keys(), ...this.reconnectTimeoutByMint.keys()]);
    this.listenersByMint.clear();
    for (const mintUrl of mints) this.retireConnection(mintUrl);
  }

  /** Replace sockets regardless of apparent liveness; return before remote readiness. */
  ensure(): void {
    for (const mintUrl of this.listenersByMint.keys()) {
      this.retireConnection(mintUrl);
      this.ensureSocket(mintUrl);
    }
  }
}
