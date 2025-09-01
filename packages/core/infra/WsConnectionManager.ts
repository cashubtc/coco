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

export class WsConnectionManager {
  private readonly sockets = new Map<string, WebSocketLike>();
  private readonly isOpenByMint = new Map<string, boolean>();
  private readonly sendQueueByMint = new Map<string, string[]>();
  private readonly logger?: Logger;

  constructor(private readonly wsFactory: WebSocketFactory, logger?: Logger) {
    this.logger = logger;
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
      const queue = this.sendQueueByMint.get(mintUrl);
      if (queue && queue.length > 0) {
        for (const payload of queue) {
          try {
            socket.send(payload);
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
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);

    return socket;
  }

  on(
    mintUrl: string,
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: any) => void,
  ): void {
    const socket = this.ensureSocket(mintUrl);
    socket.addEventListener(type, listener);
  }

  off(
    mintUrl: string,
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: any) => void,
  ): void {
    const socket = this.ensureSocket(mintUrl);
    socket.removeEventListener(type, listener);
  }

  send(mintUrl: string, message: unknown): void {
    const socket = this.ensureSocket(mintUrl);
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    if (this.isOpenByMint.get(mintUrl)) {
      try {
        socket.send(payload);
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
  }
}
