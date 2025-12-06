import { WsConnectionManager, type WebSocketFactory } from './WsConnectionManager.ts';
import type { RealTimeTransport, TransportEvent } from './RealTimeTransport.ts';
import type { WsRequest } from './SubscriptionProtocol.ts';
import type { Logger } from '../logging/Logger.ts';

export class WsTransport implements RealTimeTransport {
  private readonly ws: WsConnectionManager;

  constructor(wsFactoryOrManager: WebSocketFactory | WsConnectionManager, logger?: Logger) {
    this.ws =
      typeof wsFactoryOrManager === 'function'
        ? new WsConnectionManager(wsFactoryOrManager, logger)
        : wsFactoryOrManager;
  }

  on(mintUrl: string, event: TransportEvent, handler: (evt: any) => void): void {
    this.ws.on(mintUrl, event as any, handler);
  }

  send(mintUrl: string, req: WsRequest): void {
    this.ws.send(mintUrl, req);
  }

  closeAll(): void {
    this.ws.closeAll();
  }

  closeMint(mintUrl: string): void {
    this.ws.closeMint(mintUrl);
  }

  pause(): void {
    this.ws.pause();
  }

  resume(): void {
    this.ws.resume();
  }
}
