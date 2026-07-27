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
  send(mintUrl: string, req: WsRequest): void;
  closeAll(): void;
  closeMint(mintUrl: string): void;
  pause(): void;
  resume(): void;
}
