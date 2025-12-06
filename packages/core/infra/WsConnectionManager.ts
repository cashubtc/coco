import type { Logger } from '../logging/Logger.ts';

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: any) => void,
  ): void;
  removeEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: any) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WsConnectionManagerOptions {
  /**
   * If true, don't attempt to reconnect after close/error.
   * Useful when another mechanism (e.g., polling) handles recovery.
   * Default: false
   */
  disableReconnect?: boolean;
}

export class WsConnectionManager {
  private readonly sockets = new Map<string, WebSocketLike>();
  private readonly isOpenByMint = new Map<string, boolean>();
  private readonly sendQueueByMint = new Map<string, string[]>();
  private readonly logger?: Logger;
  private readonly listenersByMint = new Map<
    string,
    Map<'open' | 'message' | 'error' | 'close', Set<(event: any) => void>>
  >();
  private readonly reconnectAttemptsByMint = new Map<string, number>();
  private readonly reconnectTimeoutByMint = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly options: Required<WsConnectionManagerOptions>;
  private paused = false;

  constructor(
    private readonly wsFactory: WebSocketFactory,
    logger?: Logger,
    options?: WsConnectionManagerOptions,
  ) {
    this.logger = logger;
    this.options = {
      disableReconnect: options?.disableReconnect ?? false,
    };
  }

  private buildWsUrl(baseMintUrl: string): string {
    const url = new URL(baseMintUrl);
    const isSecure = url.protocol === 'https:';
    url.protocol = isSecure ? 'wss:' : 'ws:';
    const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    url.pathname = `${path}/v1/ws`;
    return url.toString();
  }

  private ensureSocket(mintUrl: string): WebSocketLike {
    const existing = this.sockets.get(mintUrl);
    if (existing) return existing;

    const wsUrl = this.buildWsUrl(mintUrl);
    const socket = this.wsFactory(wsUrl);
    this.sockets.set(mintUrl, socket);
    this.isOpenByMint.set(mintUrl, false);

    const onOpen = () => {
      this.isOpenByMint.set(mintUrl, true);
      // clear any scheduled reconnect attempts
      const pending = this.reconnectTimeoutByMint.get(mintUrl);
      if (pending) {
        clearTimeout(pending);
        this.reconnectTimeoutByMint.delete(mintUrl);
      }
      this.reconnectAttemptsByMint.delete(mintUrl);
      const queue = this.sendQueueByMint.get(mintUrl);
      if (queue && queue.length > 0) {
        this.logger?.debug('Flushing queued messages', { mintUrl, count: queue.length });
        for (const payload of queue) {
          try {
            socket.send(payload);
            this.logger?.debug('Sent queued message', { mintUrl, payloadLength: payload.length });
          } catch (err) {
            this.logger?.error('WS send error while flushing queue', { mintUrl, err });
          }
        }
        this.sendQueueByMint.set(mintUrl, []);
      }
      this.logger?.info('WS opened', { mintUrl });
    };
    const onError = (err: any) => {
      this.logger?.error('WS error', { mintUrl, err });
    };
    const onClose = () => {
      this.logger?.info('WS closed', { mintUrl });
      this.sockets.delete(mintUrl);
      this.isOpenByMint.set(mintUrl, false);
      this.sendQueueByMint.delete(mintUrl);
      // Schedule reconnect if there are listeners interested, not paused, and reconnect is enabled
      if (!this.paused && !this.options.disableReconnect) {
        const hasListeners = this.listenersByMint.get(mintUrl);
        if (hasListeners && Array.from(hasListeners.values()).some((s) => s.size > 0)) {
          this.scheduleReconnect(mintUrl);
        }
      }
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);

    // Attach any previously registered external listeners to this fresh socket
    const map = this.listenersByMint.get(mintUrl);
    if (map) {
      for (const [type, set] of map.entries()) {
        for (const listener of set.values()) {
          socket.addEventListener(type, listener);
        }
      }
    }

    return socket;
  }

  private scheduleReconnect(mintUrl: string): void {
    if (this.reconnectTimeoutByMint.get(mintUrl)) return; // already scheduled
    const attempt = (this.reconnectAttemptsByMint.get(mintUrl) ?? 0) + 1;
    this.reconnectAttemptsByMint.set(mintUrl, attempt);
    const delayMs = Math.min(30000, 1000 * 2 ** Math.min(6, attempt - 1));
    this.logger?.info('Scheduling WS reconnect', { mintUrl, attempt, delayMs });
    const timeoutId = setTimeout(() => {
      this.reconnectTimeoutByMint.delete(mintUrl);
      try {
        // ensureSocket will create a new socket and re-attach existing listeners
        this.ensureSocket(mintUrl);
      } catch (err) {
        this.logger?.error('WS reconnect attempt failed to create socket', { mintUrl, err });
        // Don't recursively retry - let the next close event trigger reconnect if needed
      }
    }, delayMs);
    this.reconnectTimeoutByMint.set(mintUrl, timeoutId);
  }

  on(
    mintUrl: string,
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: any) => void,
  ): void {
    // Check if socket already exists - if so, we'll attach directly
    // If not, we'll add to map first so ensureSocket can attach it
    const socketExists = this.sockets.has(mintUrl);

    // Persist listener so it can be re-attached across reconnects
    let map = this.listenersByMint.get(mintUrl);
    if (!map) {
      map = new Map();
      this.listenersByMint.set(mintUrl, map);
    }
    let set = map.get(type);
    if (!set) {
      set = new Set();
      map.set(type, set);
    }
    if (set.has(listener)) return;
    set.add(listener);

    // Ensure socket exists (creates if needed)
    const socket = this.ensureSocket(mintUrl);

    // Only attach directly if socket already existed
    // If socket was just created, ensureSocket already attached all listeners from map
    if (socketExists) {
      socket.addEventListener(type, listener);
    }
  }

  off(
    mintUrl: string,
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: any) => void,
  ): void {
    const socket = this.ensureSocket(mintUrl);
    socket.removeEventListener(type, listener);
    const map = this.listenersByMint.get(mintUrl);
    const set = map?.get(type);
    set?.delete(listener);
  }

  send(mintUrl: string, message: unknown): void {
    const socket = this.ensureSocket(mintUrl);
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    const isOpen = this.isOpenByMint.get(mintUrl);
    if (isOpen) {
      try {
        socket.send(payload);
        this.logger?.debug('Sent message immediately (socket open)', {
          mintUrl,
          payloadLength: payload.length,
        });
      } catch (err) {
        this.logger?.error('WS send error', { mintUrl, err });
      }
      return;
    }
    let queue = this.sendQueueByMint.get(mintUrl);
    if (!queue) {
      queue = [];
      this.sendQueueByMint.set(mintUrl, queue);
    }
    queue.push(payload);
    this.logger?.debug('Queued message (socket not open)', {
      mintUrl,
      queueLength: queue.length,
      payloadLength: payload.length,
    });
  }

  closeAll(): void {
    for (const [mintUrl, socket] of this.sockets.entries()) {
      try {
        socket.close(1000, 'Normal Closure');
      } catch (err) {
        this.logger?.warn('Error while closing WS', { mintUrl, err });
      }
    }
    this.sockets.clear();
    this.isOpenByMint.clear();
    this.sendQueueByMint.clear();
    // Do not clear listeners; callers may want to reconnect later
    for (const timeout of this.reconnectTimeoutByMint.values()) clearTimeout(timeout);
    this.reconnectTimeoutByMint.clear();
    this.reconnectAttemptsByMint.clear();
  }

  closeMint(mintUrl: string): void {
    // Close socket for this mint
    const socket = this.sockets.get(mintUrl);
    if (socket) {
      try {
        socket.close(1000, 'Mint closed');
        this.logger?.debug('WS closed for mint', { mintUrl });
      } catch (err) {
        this.logger?.warn('Error while closing WS for mint', { mintUrl, err });
      }
      this.sockets.delete(mintUrl);
    }

    // Clear state for this mint
    this.isOpenByMint.delete(mintUrl);
    this.sendQueueByMint.delete(mintUrl);
    this.listenersByMint.delete(mintUrl);

    // Clear reconnect state
    const timeout = this.reconnectTimeoutByMint.get(mintUrl);
    if (timeout) {
      clearTimeout(timeout);
      this.reconnectTimeoutByMint.delete(mintUrl);
    }
    this.reconnectAttemptsByMint.delete(mintUrl);

    this.logger?.info('WsConnectionManager closed mint', { mintUrl });
  }

  pause(): void {
    this.paused = true;
    // Clear all pending reconnect timeouts
    for (const timeout of this.reconnectTimeoutByMint.values()) {
      clearTimeout(timeout);
    }
    this.reconnectTimeoutByMint.clear();
    this.reconnectAttemptsByMint.clear();
    // Close all active sockets
    for (const [mintUrl, socket] of this.sockets.entries()) {
      try {
        socket.close(1000, 'Paused');
        this.logger?.debug('WS closed for pause', { mintUrl });
      } catch (err) {
        this.logger?.warn('Error while closing WS for pause', { mintUrl, err });
      }
    }
    this.sockets.clear();
    this.isOpenByMint.clear();
    this.sendQueueByMint.clear();
    this.logger?.info('WsConnectionManager paused');
  }

  resume(): void {
    this.paused = false;
    // Reconnect for all mints with active listeners
    for (const [mintUrl, listenerMap] of this.listenersByMint.entries()) {
      const hasListeners = Array.from(listenerMap.values()).some((s) => s.size > 0);
      if (hasListeners) {
        try {
          this.ensureSocket(mintUrl);
          this.logger?.debug('WS reconnecting after resume', { mintUrl });
        } catch (err) {
          this.logger?.error('Failed to reconnect WS after resume', { mintUrl, err });
        }
      }
    }
    this.logger?.info('WsConnectionManager resumed');
  }
}
