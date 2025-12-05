import type { RealTimeTransport, TransportEvent } from './RealTimeTransport.ts';
import type { WsRequest } from './SubscriptionProtocol.ts';
import type { WebSocketFactory } from './WsConnectionManager.ts';
import type { Logger } from '../logging/Logger.ts';
import { WsTransport } from './WsTransport.ts';
import { PollingTransport } from './PollingTransport.ts';

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
 * - Polling: Backup transport always running. Starts slow (20s), speeds up (5s) if WS fails.
 * - Deduplication: Both transports emit the same notifications, so we deduplicate at this layer.
 */
export class HybridTransport implements RealTimeTransport {
  private readonly wsTransport: WsTransport;
  private readonly pollingTransport: PollingTransport;
  private readonly logger?: Logger;
  private readonly options: Required<HybridTransportOptions>;

  // Track WS state per mint
  private readonly wsFailedByMint = new Set<string>();
  private readonly wsConnectedByMint = new Set<string>();

  // Track whether we've registered internal WS handlers for a mint
  private readonly hasInternalHandlersByMint = new Set<string>();

  // Deduplication: track last known state per (mintUrl, subId, identifier)
  private readonly lastStateByKey = new Map<string, string>();

  // Track 'open' events to dedupe (PollingTransport emits synthetic open immediately)
  private readonly hasEmittedOpenByMint = new Set<string>();

  constructor(wsFactory: WebSocketFactory, options?: HybridTransportOptions, logger?: Logger) {
    this.logger = logger;
    this.options = {
      slowPollingIntervalMs: options?.slowPollingIntervalMs ?? 20000,
      fastPollingIntervalMs: options?.fastPollingIntervalMs ?? 5000,
    };

    // Create WsTransport with reconnection disabled - we rely on polling as fallback
    this.wsTransport = new WsTransport(wsFactory, logger, { disableReconnect: true });

    // Create PollingTransport with slow interval initially
    this.pollingTransport = new PollingTransport(
      { intervalMs: this.options.slowPollingIntervalMs },
      logger,
    );
  }

  on(mintUrl: string, event: TransportEvent, handler: (evt: any) => void): void {
    // Create deduplication wrapper for the handler
    const wrappedHandler = this.createDedupeHandler(mintUrl, event, handler);

    // Register wrapped handler on BOTH transports
    this.wsTransport.on(mintUrl, event, wrappedHandler);
    this.pollingTransport.on(mintUrl, event, wrappedHandler);

    // Register internal WS state handlers (only once per mint)
    this.ensureInternalHandlers(mintUrl);
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
    this.wsFailedByMint.clear();
    this.wsConnectedByMint.clear();
    this.hasInternalHandlersByMint.clear();
    this.lastStateByKey.clear();
    this.hasEmittedOpenByMint.clear();
  }

  closeMint(mintUrl: string): void {
    this.wsTransport.closeMint(mintUrl);
    this.pollingTransport.closeMint(mintUrl);

    // Clear per-mint state
    this.wsFailedByMint.delete(mintUrl);
    this.wsConnectedByMint.delete(mintUrl);
    this.hasInternalHandlersByMint.delete(mintUrl);
    this.hasEmittedOpenByMint.delete(mintUrl);

    // Clear deduplication state for this mint (keys start with mintUrl::)
    for (const key of this.lastStateByKey.keys()) {
      if (key.startsWith(`${mintUrl}::`)) {
        this.lastStateByKey.delete(key);
      }
    }

    this.logger?.info('HybridTransport closed mint', { mintUrl });
  }

  pause(): void {
    this.wsTransport.pause();
    this.pollingTransport.pause();
    this.logger?.info('HybridTransport paused');
  }

  resume(): void {
    this.wsTransport.resume();
    this.pollingTransport.resume();
    this.logger?.info('HybridTransport resumed');
  }

  /**
   * Register internal handlers on WsTransport to track connection state.
   * Only registers once per mint.
   */
  private ensureInternalHandlers(mintUrl: string): void {
    if (this.hasInternalHandlersByMint.has(mintUrl)) return;
    this.hasInternalHandlersByMint.add(mintUrl);

    // Track successful WS connection
    this.wsTransport.on(mintUrl, 'open', () => {
      this.wsConnectedByMint.add(mintUrl);
      this.logger?.debug('HybridTransport: WS connected', { mintUrl });
    });

    // Track WS close - mark as failed (no reconnect, polling compensates)
    this.wsTransport.on(mintUrl, 'close', () => {
      this.handleWsFailure(mintUrl);
    });
  }

  /**
   * Handle WS failure - mark as failed and speed up polling.
   */
  private handleWsFailure(mintUrl: string): void {
    if (this.wsFailedByMint.has(mintUrl)) return; // Already failed
    this.wsFailedByMint.add(mintUrl);
    this.updatePollingInterval(mintUrl);
    this.logger?.info('HybridTransport: WS failed, polling will compensate', { mintUrl });
  }

  /**
   * Speed up polling for a mint after WS failure.
   */
  private updatePollingInterval(mintUrl: string): void {
    this.pollingTransport.setIntervalForMint(mintUrl, this.options.fastPollingIntervalMs);
    this.logger?.debug('HybridTransport: Polling interval updated', {
      mintUrl,
      intervalMs: this.options.fastPollingIntervalMs,
    });
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
      // Dedupe 'open' events - only emit once per mint
      if (event === 'open') {
        if (this.hasEmittedOpenByMint.has(mintUrl)) {
          this.logger?.debug('HybridTransport: Deduped open event', { mintUrl });
          return;
        }
        this.hasEmittedOpenByMint.add(mintUrl);
        originalHandler(evt);
        return;
      }

      // Pass through close/error events without deduplication
      if (event === 'close' || event === 'error') {
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

        const key = this.getStateKey(mintUrl, parsed);
        // Only compare 'state' field - that's all we care about
        const stateJson = JSON.stringify(parsed.params?.payload?.state);

        const lastState = this.lastStateByKey.get(key);
        if (lastState === stateJson) {
          // Duplicate state, skip
          this.logger?.debug('HybridTransport: Deduped notification', { mintUrl, key });
          return;
        }

        this.lastStateByKey.set(key, stateJson);
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
}
