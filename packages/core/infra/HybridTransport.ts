import { Amount, type AmountLike } from '@cashu/cashu-ts';
import type { RealTimeTransport, TransportEvent } from './RealTimeTransport.ts';
import type { WsRequest } from './SubscriptionProtocol.ts';
import { WsConnectionManager, type WebSocketFactory } from './WsConnectionManager.ts';
import type { Logger } from '../logging/Logger.ts';
import type { MintAdapter } from './MintAdapter.ts';
import { PollingTransport } from './PollingTransport.ts';
import type { MintQuotePollingOperation } from '../quotes/MintQuotePolling.ts';

export interface HybridTransportOptions {
  /** Polling interval while WS is connected (default: 20000ms) */
  slowPollingIntervalMs?: number;
  /** Polling interval after WS fails (default: 5000ms) */
  fastPollingIntervalMs?: number;
}

/**
 * HybridTransport runs both WebSocket and polling transports in parallel.
 *
 * - WebSocket: Primary transport for real-time updates. One-shot per mint—no reconnection on failure.
 * - Polling: Backup transport always running. Runs fast (5s) until WS opens, then slows down (20s).
 * - Deduplication: Both transports emit the same notifications, so we deduplicate at this layer.
 */
export class HybridTransport implements RealTimeTransport {
  private readonly wsTransport: RealTimeTransport;
  private readonly pollingTransport: PollingTransport;
  private readonly options: Required<HybridTransportOptions>;

  // Track whether we've registered internal WS handlers for a mint
  private readonly hasInternalHandlersByMint = new Set<string>();

  // Deduplication: track last notification signature per (mintUrl, subId, identifier)
  private readonly lastNotificationSignatureByKey = new Map<string, string>();

  constructor(
    wsFactory: WebSocketFactory,
    mintAdapter: MintAdapter,
    options?: HybridTransportOptions,
    logger?: Logger,
    mintQuotePolling?: MintQuotePollingOperation,
  ) {
    this.options = {
      slowPollingIntervalMs: options?.slowPollingIntervalMs ?? 20000,
      fastPollingIntervalMs: options?.fastPollingIntervalMs ?? 5000,
    };

    // Disable reconnection - we rely on polling as fallback
    this.wsTransport = new WsConnectionManager(wsFactory, logger, { disableReconnect: true });

    // Poll at the fast interval until a socket actually opens.
    this.pollingTransport = new PollingTransport(
      mintAdapter,
      { intervalMs: this.options.fastPollingIntervalMs },
      logger,
      mintQuotePolling,
    );
  }

  on(mintUrl: string, event: TransportEvent, handler: (evt: any) => void): void {
    // Create deduplication wrapper for the handler
    const wrappedHandler = this.createDedupeHandler(mintUrl, event, handler);

    this.ensureInternalHandlers(mintUrl);
    this.wsTransport.on(mintUrl, event, wrappedHandler);
    this.pollingTransport.on(mintUrl, event, wrappedHandler);
  }

  send(mintUrl: string, req: WsRequest): void {
    // Forward to BOTH transports - polling always needs to know about subscriptions
    this.wsTransport.send(mintUrl, req);
    this.pollingTransport.send(mintUrl, req);
  }

  closeAll(): void {
    this.wsTransport.closeAll();
    this.pollingTransport.closeAll();

    // Clear all state
    this.hasInternalHandlersByMint.clear();
    this.lastNotificationSignatureByKey.clear();
  }

  closeMint(mintUrl: string): void {
    this.wsTransport.closeMint(mintUrl);
    this.pollingTransport.closeMint(mintUrl);

    // Clear per-mint state
    this.hasInternalHandlersByMint.delete(mintUrl);

    // Clear deduplication state for this mint (keys start with mintUrl::)
    for (const key of this.lastNotificationSignatureByKey.keys()) {
      if (key.startsWith(`${mintUrl}::`)) {
        this.lastNotificationSignatureByKey.delete(key);
      }
    }
  }

  ensure(): void {
    // A delivered observation may have failed downstream. Permit fresh evidence to
    // reach callbacks again; canonical quote merging remains authoritative.
    this.lastNotificationSignatureByKey.clear();
    for (const mintUrl of this.hasInternalHandlersByMint) this.handleWsFailure(mintUrl);
    this.wsTransport.ensure();
    this.pollingTransport.ensure();
  }

  /**
   * Register internal WebSocket handlers to track connection state.
   * Only registers once per mint.
   */
  private ensureInternalHandlers(mintUrl: string): void {
    if (this.hasInternalHandlersByMint.has(mintUrl)) return;
    this.hasInternalHandlersByMint.add(mintUrl);

    // Track successful WS connection
    this.wsTransport.on(mintUrl, 'open', () => {
      this.pollingTransport.setIntervalForMint(mintUrl, this.options.slowPollingIntervalMs);
    });

    // Use fallback cadence on WS errors or closure (no automatic reconnect)
    for (const event of ['close', 'error'] as const) {
      this.wsTransport.on(mintUrl, event, () => this.handleWsFailure(mintUrl));
    }
  }

  /**
   * Use fallback cadence until a fresh socket opens.
   */
  private handleWsFailure(mintUrl: string): void {
    this.pollingTransport.setIntervalForMint(mintUrl, this.options.fastPollingIntervalMs);
  }

  /**
   * Create a handler wrapper that deduplicates events.
   */
  private createDedupeHandler(
    mintUrl: string,
    event: TransportEvent,
    originalHandler: (evt: any) => void,
  ): (evt: any) => void {
    return (evt: any) => {
      if (event !== 'message') {
        originalHandler(evt);
        return;
      }

      // For 'message' events, dedupe based on state
      try {
        const data = typeof evt.data === 'string' ? evt.data : evt.data?.toString?.();
        if (!data) {
          originalHandler(evt);
          return;
        }

        const parsed = JSON.parse(data);

        // Only dedupe subscription notifications (method === 'subscribe')
        if (parsed.method !== 'subscribe') {
          originalHandler(evt);
          return;
        }

        const signature = this.getNotificationSignature(parsed.params?.payload);
        if (signature === undefined) {
          originalHandler(evt);
          return;
        }

        const key = this.getStateKey(mintUrl, parsed);

        const lastSignature = this.lastNotificationSignatureByKey.get(key);
        if (lastSignature === signature) {
          // Duplicate notification signature, skip
          return;
        }

        this.lastNotificationSignatureByKey.set(key, signature);
        originalHandler(evt);
      } catch {
        // Parse failed, pass through
        originalHandler(evt);
      }
    };
  }

  /**
   * Generate a deduplication key for a notification.
   * Includes mintUrl, subId, and identifier (Y for proofs, quote for quotes).
   */
  private getStateKey(
    mintUrl: string,
    notification: { params?: { subId?: string; payload?: { Y?: string; quote?: string } } },
  ): string {
    const subId = notification.params?.subId ?? '';
    const payload = notification.params?.payload;
    // Include identifier to differentiate items within the same subscription:
    // - For proof_state: Y identifies the specific proof
    // - For quotes: quote field identifies the specific quote
    const identifier = payload?.Y ?? payload?.quote ?? '';
    return `${mintUrl}::${subId}::${identifier}`;
  }

  private getNotificationSignature(
    payload:
      | {
          state?: unknown;
          amount_paid?: unknown;
          amount_issued?: unknown;
          expiry?: unknown;
        }
      | undefined,
  ): string | undefined {
    if (!payload) return undefined;

    const expirySignature = this.getExpirySignature(payload);
    if (payload.amount_paid !== undefined && payload.amount_issued !== undefined) {
      try {
        return `${Amount.from(payload.amount_paid as AmountLike).toString()}:${Amount.from(
          payload.amount_issued as AmountLike,
        ).toString()}:${expirySignature}`;
      } catch {
        return undefined;
      }
    }

    if (payload.state !== undefined) {
      return `${JSON.stringify(payload.state)}:${expirySignature}`;
    }

    return undefined;
  }

  private getExpirySignature(payload: { expiry?: unknown }): string {
    if (typeof payload.expiry !== 'number' || payload.expiry === 0) {
      return 'no-expiry';
    }

    return String(payload.expiry);
  }
}
