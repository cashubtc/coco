import type { WsRequest } from './SubscriptionProtocol.ts';

export type TransportEvent = 'open' | 'message' | 'close' | 'error';

/** A serialized transport message with its exact pre-serialization payload when already normalized. */
export interface TransportMessageEvent {
  data: unknown;
  /** Present for polling notifications that have already crossed the adapter normalization seam. */
  normalizedPayload?: unknown;
}

export interface RealTimeTransport {
  on(mintUrl: string, event: TransportEvent, handler: (evt: any) => void): void;
  /** Register polling work or send on a live socket; open replay supplies disconnected interests. */
  send(mintUrl: string, req: WsRequest): void;
  closeAll(): void;
  closeMint(mintUrl: string): void;
  /**
   * Initiate local networking repair without waiting for remote readiness.
   * Preserve polling interests; replace sockets and emit open when each replacement connects.
   * The open listener replays current logical subscriptions. Replayed subscribe requests
   * must be idempotent for polling. Retired connections must not emit events.
   */
  ensure(): void;
}
