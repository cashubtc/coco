import { describe, it, expect } from 'bun:test';
import { WsConnectionManager, type WebSocketLike } from '../../infra/WsConnectionManager';
import { NullLogger } from '../../logging';

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

describe('WsConnectionManager disableReconnect option', () => {
  it('should reconnect by default when disableReconnect is not set', async () => {
    let callCount = 0;
    let socket!: MockWebSocket;
    const factory = (url: string): WebSocketLike => {
      callCount++;
      socket = new MockWebSocket();
      return socket;
    };

    const wsManager = new WsConnectionManager(factory, new NullLogger());
    const mintUrl = 'https://mint.example.com';

    wsManager.on(mintUrl, 'open', () => {});
    expect(callCount).toBe(1);

    // Simulate connection then close
    socket.triggerOpen();
    socket.triggerClose();

    // Wait for reconnect (1s delay for first attempt)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Should have attempted reconnect
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('should not reconnect when disableReconnect is true', async () => {
    let callCount = 0;
    let socket!: MockWebSocket;
    const factory = (url: string): WebSocketLike => {
      callCount++;
      socket = new MockWebSocket();
      return socket;
    };

    const wsManager = new WsConnectionManager(factory, new NullLogger(), {
      disableReconnect: true,
    });
    const mintUrl = 'https://mint.example.com';

    wsManager.on(mintUrl, 'open', () => {});
    expect(callCount).toBe(1);

    // Simulate connection then close
    socket.triggerOpen();
    socket.triggerClose();

    // Wait to ensure no reconnect happens
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Should NOT have attempted reconnect
    expect(callCount).toBe(1);
  });

  it('should not reconnect when disableReconnect is true and handshake fails', async () => {
    let callCount = 0;
    const factory = (url: string): WebSocketLike => {
      callCount++;
      const socket = new MockWebSocket();
      // Simulate immediate close (handshake failure)
      queueMicrotask(() => socket.triggerClose());
      return socket;
    };

    const wsManager = new WsConnectionManager(factory, new NullLogger(), {
      disableReconnect: true,
    });
    const mintUrl = 'https://mint.example.com';

    wsManager.on(mintUrl, 'open', () => {});
    expect(callCount).toBe(1);

    // Wait to ensure no reconnect happens
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Should NOT have attempted reconnect despite handshake failure
    expect(callCount).toBe(1);
  });

  it('should still allow manual repair when disableReconnect is true', () => {
    let callCount = 0;
    let socket!: MockWebSocket;
    const factory = (url: string): WebSocketLike => {
      callCount++;
      socket = new MockWebSocket();
      return socket;
    };

    const wsManager = new WsConnectionManager(factory, new NullLogger(), {
      disableReconnect: true,
    });
    const mintUrl = 'https://mint.example.com';

    wsManager.on(mintUrl, 'open', () => {});
    expect(callCount).toBe(1);

    wsManager.ensure();

    // Repair creates new connections for mints with listeners
    expect(callCount).toBe(2);
  });
});
