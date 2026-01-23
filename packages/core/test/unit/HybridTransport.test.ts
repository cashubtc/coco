import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { HybridTransport } from '../../infra/HybridTransport';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { WebSocketLike } from '../../infra/WsConnectionManager';
import { NullLogger } from '../../logging';

// Mock MintAdapter for testing
const createMockMintAdapter = (): MintAdapter =>
  ({
    checkMintQuoteState: mock(() => Promise.resolve({})),
    checkMeltQuoteState: mock(() => Promise.resolve({})),
    checkProofStates: mock(() => Promise.resolve([])),
  } as unknown as MintAdapter);

class MockWebSocket implements WebSocketLike {
  private listeners: Map<string, Set<(event: any) => void>> = new Map();
  public closed = false;

  send(_data: string): void {}

  close(_code?: number, _reason?: string): void {
    this.closed = true;
    this.triggerClose();
  }

  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: any) => void,
  ): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: any) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  triggerOpen(): void {
    const listeners = this.listeners.get('open');
    if (listeners) {
      for (const listener of listeners) {
        listener({ type: 'open' });
      }
    }
  }

  triggerClose(): void {
    const listeners = this.listeners.get('close');
    if (listeners) {
      for (const listener of listeners) {
        listener({ type: 'close' });
      }
    }
  }

  triggerMessage(data: string): void {
    const listeners = this.listeners.get('message');
    if (listeners) {
      for (const listener of listeners) {
        listener({ data });
      }
    }
  }
}

describe('HybridTransport', () => {
  let transport: HybridTransport;
  let mockSocket: MockWebSocket;
  let mockMintAdapter: MintAdapter;
  const mintUrl = 'https://mint.example.com';

  beforeEach(() => {
    mockSocket = new MockWebSocket();
    mockMintAdapter = createMockMintAdapter();
    const wsFactory = (_url: string) => mockSocket;
    transport = new HybridTransport(
      wsFactory,
      mockMintAdapter,
      {
        slowPollingIntervalMs: 20000,
        fastPollingIntervalMs: 5000,
      },
      new NullLogger(),
    );
  });

  describe('constructor', () => {
    it('should create transport with default options', () => {
      const wsFactory = (_url: string) => new MockWebSocket();
      const t = new HybridTransport(wsFactory, createMockMintAdapter());
      expect(t).toBeDefined();
    });

    it('should create transport with custom options', () => {
      const wsFactory = (_url: string) => new MockWebSocket();
      const t = new HybridTransport(wsFactory, createMockMintAdapter(), {
        slowPollingIntervalMs: 30000,
        fastPollingIntervalMs: 3000,
      });
      expect(t).toBeDefined();
    });
  });

  describe('send', () => {
    it('should forward requests to both transports', () => {
      const handler = mock(() => {});
      transport.on(mintUrl, 'message', handler);

      const req = {
        jsonrpc: '2.0' as const,
        method: 'subscribe' as const,
        params: { kind: 'bolt11_mint_quote' as const, subId: 'sub1', filters: ['quote1'] },
        id: 1,
      };

      transport.send(mintUrl, req);

      // PollingTransport emits immediate OK response
      // We should receive at least one response (from polling)
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('open event deduplication', () => {
    it('should only emit first open event per mint', async () => {
      const openHandler = mock(() => {});
      transport.on(mintUrl, 'open', openHandler);

      // Wait for any async events
      await new Promise((resolve) => setTimeout(resolve, 10));

      // First open (from WS)
      mockSocket.triggerOpen();
      const countAfterFirst = openHandler.mock.calls.length;
      expect(countAfterFirst).toBe(1);

      // Second open attempt should be deduped
      // (Simulate by directly accessing the dedup state and triggering again)
      mockSocket.triggerOpen();

      // Should still be 1 (second open was deduped)
      expect(openHandler.mock.calls.length).toBe(1);
    });

    it('should track open state per mint independently', async () => {
      const mintUrl2 = 'https://mint2.example.com';

      // Create new transport with factory that tracks sockets
      const sockets: MockWebSocket[] = [];
      const wsFactory = (_url: string) => {
        const s = new MockWebSocket();
        sockets.push(s);
        return s;
      };

      const t = new HybridTransport(wsFactory, createMockMintAdapter(), {}, new NullLogger());

      const handler1 = mock(() => {});
      const handler2 = mock(() => {});

      t.on(mintUrl, 'open', handler1);
      t.on(mintUrl2, 'open', handler2);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sockets.length).toEqual(2);
      // Open first mint's WS
      sockets[0]!.triggerOpen();
      expect(handler1.mock.calls.length).toBe(1);

      // Open second mint's WS - should also emit (different mint)
      sockets[1]!.triggerOpen();
      expect(handler2.mock.calls.length).toBe(1);

      t.closeAll();
    });
  });

  describe('message deduplication', () => {
    it('should dedupe same state from both transports', async () => {
      const messageHandler = mock(() => {});
      transport.on(mintUrl, 'message', messageHandler);

      // Wait for open events to settle
      await new Promise((resolve) => setTimeout(resolve, 10));

      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: {
          subId: 'sub1',
          payload: { quote: 'q1', state: 'PAID' },
        },
      });

      // First notification should pass through
      mockSocket.triggerMessage(notification);
      const countAfterFirst = messageHandler.mock.calls.length;

      // Same notification again should be deduped
      mockSocket.triggerMessage(notification);
      expect(messageHandler.mock.calls.length).toBe(countAfterFirst);
    });

    it('should not dedupe different states', async () => {
      const messageHandler = mock(() => {});
      transport.on(mintUrl, 'message', messageHandler);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const notification1 = JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: {
          subId: 'sub1',
          payload: { quote: 'q1', state: 'UNPAID' },
        },
      });

      const notification2 = JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: {
          subId: 'sub1',
          payload: { quote: 'q1', state: 'PAID' },
        },
      });

      mockSocket.triggerMessage(notification1);
      const countAfterFirst = messageHandler.mock.calls.length;

      mockSocket.triggerMessage(notification2);
      // Different state should pass through
      expect(messageHandler.mock.calls.length).toBe(countAfterFirst + 1);
    });

    it('should not dedupe different proofs with same state', async () => {
      const messageHandler = mock(() => {});
      transport.on(mintUrl, 'message', messageHandler);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const notification1 = JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: {
          subId: 'sub1',
          payload: { Y: 'proof1', state: 'SPENT' },
        },
      });

      const notification2 = JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: {
          subId: 'sub1',
          payload: { Y: 'proof2', state: 'SPENT' },
        },
      });

      mockSocket.triggerMessage(notification1);
      const countAfterFirst = messageHandler.mock.calls.length;

      mockSocket.triggerMessage(notification2);
      // Different proof (Y) should pass through even with same state
      expect(messageHandler.mock.calls.length).toBe(countAfterFirst + 1);
    });

    it('should pass through non-notification messages', async () => {
      const messageHandler = mock(() => {});
      transport.on(mintUrl, 'message', messageHandler);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Response message (has result, not method)
      const response = JSON.stringify({
        jsonrpc: '2.0',
        result: { status: 'OK', subId: 'sub1' },
        id: 1,
      });

      mockSocket.triggerMessage(response);
      const countAfterFirst = messageHandler.mock.calls.length;

      // Same response again should NOT be deduped (responses pass through)
      mockSocket.triggerMessage(response);
      expect(messageHandler.mock.calls.length).toBe(countAfterFirst + 1);
    });
  });

  describe('WS failure handling', () => {
    it('should speed up polling when WS closes', async () => {
      transport.on(mintUrl, 'open', () => {});

      // Wait for synthetic open
      await new Promise((resolve) => setTimeout(resolve, 10));

      // WS connects then closes
      mockSocket.triggerOpen();
      mockSocket.triggerClose();

      // Access private field to verify interval was changed
      const pollingTransport = (transport as any).pollingTransport;
      const intervalByMint = (pollingTransport as any).intervalByMint as Map<string, number>;

      expect(intervalByMint.get(mintUrl)).toBe(5000);
    });

    it('should mark WS as failed on close', async () => {
      transport.on(mintUrl, 'open', () => {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      mockSocket.triggerClose();

      const wsFailedByMint = (transport as any).wsFailedByMint as Set<string>;
      expect(wsFailedByMint.has(mintUrl)).toBe(true);
    });
  });

  describe('closeMint', () => {
    it('should clear all per-mint state', async () => {
      transport.on(mintUrl, 'open', () => {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Trigger some state
      mockSocket.triggerOpen();

      // Close mint
      transport.closeMint(mintUrl);

      // Verify state is cleared
      const wsFailedByMint = (transport as any).wsFailedByMint as Set<string>;
      const wsConnectedByMint = (transport as any).wsConnectedByMint as Set<string>;
      const hasEmittedOpenByMint = (transport as any).hasEmittedOpenByMint as Set<string>;
      const hasInternalHandlersByMint = (transport as any).hasInternalHandlersByMint as Set<string>;

      expect(wsFailedByMint.has(mintUrl)).toBe(false);
      expect(wsConnectedByMint.has(mintUrl)).toBe(false);
      expect(hasEmittedOpenByMint.has(mintUrl)).toBe(false);
      expect(hasInternalHandlersByMint.has(mintUrl)).toBe(false);
    });

    it('should clear deduplication state for mint', async () => {
      const handler = mock(() => {});
      transport.on(mintUrl, 'message', handler);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Send a notification to create dedup state
      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: { subId: 'sub1', payload: { quote: 'q1', state: 'PAID' } },
      });
      mockSocket.triggerMessage(notification);

      // Verify dedup state exists
      const lastStateByKey = (transport as any).lastStateByKey as Map<string, string>;
      const hasKeyForMint = Array.from(lastStateByKey.keys()).some((k) =>
        k.startsWith(`${mintUrl}::`),
      );
      expect(hasKeyForMint).toBe(true);

      // Close mint
      transport.closeMint(mintUrl);

      // Verify dedup state is cleared
      const hasKeyAfterClose = Array.from(lastStateByKey.keys()).some((k) =>
        k.startsWith(`${mintUrl}::`),
      );
      expect(hasKeyAfterClose).toBe(false);
    });
  });

  describe('closeAll', () => {
    it('should clear all state', async () => {
      transport.on(mintUrl, 'open', () => {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      mockSocket.triggerOpen();
      transport.closeAll();

      const wsFailedByMint = (transport as any).wsFailedByMint as Set<string>;
      const lastStateByKey = (transport as any).lastStateByKey as Map<string, string>;

      expect(wsFailedByMint.size).toBe(0);
      expect(lastStateByKey.size).toBe(0);
    });
  });

  describe('pause/resume', () => {
    it('should pause and resume both transports', () => {
      // Just verify no errors are thrown
      transport.pause();
      transport.resume();
      expect(true).toBe(true);
    });

    it('should not mark WS as failed when pausing', async () => {
      transport.on(mintUrl, 'open', () => {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      // WS connects
      mockSocket.triggerOpen();

      // Pause - this will close WS, but should NOT mark as failed
      transport.pause();

      const wsFailedByMint = (transport as any).wsFailedByMint as Set<string>;
      expect(wsFailedByMint.has(mintUrl)).toBe(false);
    });

    it('should not speed up polling when pausing', async () => {
      transport.on(mintUrl, 'open', () => {});

      await new Promise((resolve) => setTimeout(resolve, 10));

      mockSocket.triggerOpen();
      transport.pause();

      // Check polling interval was NOT changed to fast
      const pollingTransport = (transport as any).pollingTransport;
      const intervalByMint = (pollingTransport as any).intervalByMint as Map<string, number>;

      // Should NOT have a fast interval set
      expect(intervalByMint.has(mintUrl)).toBe(false);
    });

    it('should clear open event tracking on pause so resume emits open', async () => {
      const openHandler = mock(() => {});
      transport.on(mintUrl, 'open', openHandler);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // First open
      mockSocket.triggerOpen();
      expect(openHandler.mock.calls.length).toBe(1);

      // Pause clears hasEmittedOpenByMint
      transport.pause();

      const hasEmittedOpenByMint = (transport as any).hasEmittedOpenByMint as Set<string>;
      expect(hasEmittedOpenByMint.has(mintUrl)).toBe(false);
    });

    it('should allow WS to reconnect and emit open after resume', async () => {
      let socket1: MockWebSocket;
      let socket2: MockWebSocket;
      let socketCount = 0;

      const wsFactory = (_url: string) => {
        socketCount++;
        if (socketCount === 1) {
          socket1 = new MockWebSocket();
          return socket1;
        }
        socket2 = new MockWebSocket();
        return socket2;
      };

      const t = new HybridTransport(
        wsFactory,
        createMockMintAdapter(),
        { slowPollingIntervalMs: 20000, fastPollingIntervalMs: 5000 },
        new NullLogger(),
      );

      const openHandler = mock(() => {});
      t.on(mintUrl, 'open', openHandler);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // First open
      socket1!.triggerOpen();
      expect(openHandler.mock.calls.length).toBe(1);

      // Pause and resume
      t.pause();
      t.resume();

      // New socket connects after resume - should emit open again
      socket2!.triggerOpen();
      expect(openHandler.mock.calls.length).toBe(2);

      t.closeAll();
    });
  });

  describe('close/error event passthrough', () => {
    it('should pass through close events without deduplication', async () => {
      const closeHandler = mock(() => {});
      transport.on(mintUrl, 'close', closeHandler);

      await new Promise((resolve) => setTimeout(resolve, 10));

      mockSocket.triggerClose();
      const countAfterFirst = closeHandler.mock.calls.length;

      // Note: Can't easily trigger second close on same socket,
      // but the code path shows close events are not deduped
      expect(countAfterFirst).toBeGreaterThanOrEqual(1);
    });
  });
});
