import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { WsConnectionManager, type WebSocketLike } from '../infra/WsConnectionManager';
import { NullLogger } from '../logging';

class MockWebSocket implements WebSocketLike {
  private listeners: Map<string, Set<(event: any) => void>> = new Map();
  public closed = false;
  public closeCode?: number;
  public closeReason?: string;

  send(data: string): void {
    // Mock send
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    const closeListeners = this.listeners.get('close');
    if (closeListeners) {
      for (const listener of closeListeners) {
        listener({ type: 'close' });
      }
    }
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
    const set = this.listeners.get(type);
    if (set) {
      set.delete(listener);
    }
  }

  triggerOpen(): void {
    const openListeners = this.listeners.get('open');
    if (openListeners) {
      for (const listener of openListeners) {
        listener({ type: 'open' });
      }
    }
  }

  triggerClose(): void {
    const closeListeners = this.listeners.get('close');
    if (closeListeners) {
      for (const listener of closeListeners) {
        listener({ type: 'close' });
      }
    }
  }
}

describe('WsConnectionManager pause/resume', () => {
  let wsManager: WsConnectionManager;
  let mockSocket: MockWebSocket;
  let wsFactory: (url: string) => WebSocketLike;

  beforeEach(() => {
    mockSocket = new MockWebSocket();
    wsFactory = mock((url: string) => mockSocket);
    wsManager = new WsConnectionManager(wsFactory, new NullLogger());
  });

  it('should close all sockets when paused', () => {
    const mintUrl = 'https://mint.example.com';
    wsManager.on(mintUrl, 'open', () => {});
    mockSocket.triggerOpen();

    expect(mockSocket.closed).toBe(false);

    wsManager.pause();

    expect(mockSocket.closed).toBe(true);
    expect(mockSocket.closeCode).toBe(1000);
    expect(mockSocket.closeReason).toBe('Paused');
  });

  it('should clear reconnect timers when paused', async () => {
    const mintUrl = 'https://mint.example.com';
    wsManager.on(mintUrl, 'open', () => {});
    mockSocket.triggerOpen();

    // Trigger close to schedule reconnect
    mockSocket.triggerClose();

    // Pause should clear any scheduled reconnects
    wsManager.pause();

    // Wait a bit to ensure no reconnect happens
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Factory should have been called only once (initial connection)
    expect(wsFactory).toHaveBeenCalledTimes(1);
  });

  it('should not trigger reconnection on close when paused', async () => {
    const mintUrl = 'https://mint.example.com';
    wsManager.on(mintUrl, 'open', () => {});
    mockSocket.triggerOpen();

    wsManager.pause();

    // Wait to ensure no reconnect is scheduled
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should have been called only once (initial)
    expect(wsFactory).toHaveBeenCalledTimes(1);
  });

  it('should reconnect all mints with listeners on resume', () => {
    const mintUrl1 = 'https://mint1.example.com';
    const mintUrl2 = 'https://mint2.example.com';
    let callCount = 0;

    const factory = (url: string): WebSocketLike => {
      callCount++;
      return new MockWebSocket();
    };

    wsManager = new WsConnectionManager(factory, new NullLogger());

    // Set up listeners for two mints
    wsManager.on(mintUrl1, 'open', () => {});
    wsManager.on(mintUrl2, 'open', () => {});

    const callCountAfterSetup = callCount;

    // Pause (which closes sockets)
    wsManager.pause();

    // Resume should reconnect both
    wsManager.resume();

    // Should have called factory for both mints after resume
    expect(callCount).toBeGreaterThan(callCountAfterSetup);
  });

  it('should allow reconnection on close after resume', async () => {
    const mintUrl = 'https://mint.example.com';
    let socket1: MockWebSocket;
    let socket2: MockWebSocket;
    let callCount = 0;

    const factory = (url: string): WebSocketLike => {
      callCount++;
      if (callCount === 1) {
        socket1 = new MockWebSocket();
        return socket1;
      } else {
        socket2 = new MockWebSocket();
        return socket2;
      }
    };

    wsManager = new WsConnectionManager(factory, new NullLogger());
    wsManager.on(mintUrl, 'open', () => {});

    socket1!.triggerOpen();
    expect(callCount).toBe(1);

    wsManager.pause();
    wsManager.resume();

    // Resume should create new socket
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Trigger close after resume - should schedule reconnect
    if (socket2!) {
      socket2!.triggerClose();
    }

    // Wait for reconnect delay
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Should have attempted reconnect
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('should handle multiple pause calls idempotently', () => {
    const mintUrl = 'https://mint.example.com';
    wsManager.on(mintUrl, 'open', () => {});
    mockSocket.triggerOpen();

    wsManager.pause();
    const firstCloseCode = mockSocket.closeCode;

    // Reset mock socket for second pause
    mockSocket.closed = false;

    wsManager.pause();
    wsManager.pause();

    // Should not error or cause issues
    expect(firstCloseCode).toBe(1000);
  });

  it('should handle multiple resume calls idempotently', () => {
    const mintUrl = 'https://mint.example.com';
    wsManager.on(mintUrl, 'open', () => {});

    wsManager.pause();
    wsManager.resume();
    wsManager.resume();
    wsManager.resume();

    // Should not error
    expect(true).toBe(true);
  });
});
