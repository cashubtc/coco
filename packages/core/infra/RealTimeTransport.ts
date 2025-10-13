import type { WsRequest } from './SubscriptionProtocol.ts';

export type TransportEvent = 'open' | 'message' | 'close' | 'error';

export interface RealTimeTransport {
  on(mintUrl: string, event: TransportEvent, handler: (evt: any) => void): void;
  send(mintUrl: string, req: WsRequest): void;
  closeAll(): void;
  pause(): void;
  resume(): void;
}
