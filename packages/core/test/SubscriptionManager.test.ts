import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SubscriptionManager } from '../infra/SubscriptionManager';
import type { RealTimeTransport } from '../infra/RealTimeTransport';
import type { WsRequest } from '../infra/SubscriptionProtocol';
import { NullLogger } from '../logging';

class MockTransport implements RealTimeTransport {
  public paused = false;
  public resumed = false;
  public sentMessages: WsRequest[] = [];
  private listeners: Map<string, Map<string, Set<(evt: any) => void>>> = new Map();

  on(
    mintUrl: string,
    event: 'open' | 'message' | 'error' | 'close',
    handler: (evt: any) => void,
  ): void {
    if (!this.listeners.has(mintUrl)) {
      this.listeners.set(mintUrl, new Map());
    }
    const mintListeners = this.listeners.get(mintUrl)!;
    if (!mintListeners.has(event)) {
      mintListeners.set(event, new Set());
    }
    mintListeners.get(event)!.add(handler);

    // Simulate open event
    if (event === 'open') {
      queueMicrotask(() => handler({ type: 'open' }));
    }
  }

  send(mintUrl: string, req: WsRequest): void {
    this.sentMessages.push(req);
    // Simulate successful subscription response
    const messageListeners = this.listeners.get(mintUrl)?.get('message');
    if (messageListeners && req.method === 'subscribe') {
      const response = {
        data: JSON.stringify({
          jsonrpc: '2.0',
          result: { status: 'OK', subId: (req.params as any).subId },
          id: req.id,
        }),
      };
      queueMicrotask(() => {
        for (const listener of messageListeners) {
          listener(response);
        }
      });
    }
  }

  closeAll(): void {
    this.listeners.clear();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.resumed = true;
    this.paused = false;
  }

  triggerMessage(mintUrl: string, notification: any): void {
    const messageListeners = this.listeners.get(mintUrl)?.get('message');
    if (messageListeners) {
      for (const listener of messageListeners) {
        listener({ data: JSON.stringify(notification) });
      }
    }
  }
}

describe('SubscriptionManager pause/resume', () => {
  let mockTransport: MockTransport;
  let subManager: SubscriptionManager;

  beforeEach(() => {
    mockTransport = new MockTransport();
    subManager = new SubscriptionManager(mockTransport, new NullLogger());
  });

  it('should call pause on all transports when paused', () => {
    subManager.pause();
    expect(mockTransport.paused).toBe(true);
  });

  it('should call resume on all transports when resumed', () => {
    subManager.pause();
    subManager.resume();
    expect(mockTransport.resumed).toBe(true);
  });

  it('should allow subscriptions while paused but not send until resume', async () => {
    const mintUrl = 'https://mint.example.com';

    const messageCountBeforePause = mockTransport.sentMessages.length;
    subManager.pause();

    // Subscribe while paused
    const { subId } = await subManager.subscribe(mintUrl, 'bolt11_mint_quote', ['quote1']);

    // Subscription should be created
    expect(subId).toBeDefined();

    // But no subscribe message should be sent yet (still at same count)
    expect(mockTransport.sentMessages.length).toBe(messageCountBeforePause);

    // Now resume
    subManager.resume();

    // Wait for async re-subscription
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now the subscribe message should have been sent
    expect(mockTransport.sentMessages.length).toBeGreaterThan(messageCountBeforePause);

    const subscribeMessages = mockTransport.sentMessages.filter(
      (msg) => msg.method === 'subscribe' && (msg.params as any).subId === subId,
    );
    expect(subscribeMessages.length).toBeGreaterThan(0);

    await subManager.unsubscribe(mintUrl, subId);
  });

  it('should re-subscribe all active subscriptions on resume', async () => {
    const mintUrl = 'https://mint.example.com';

    // Create a subscription
    const { subId } = await subManager.subscribe(mintUrl, 'bolt11_mint_quote', [
      'quote1',
      'quote2',
    ]);

    const messageCountBeforePause = mockTransport.sentMessages.length;

    // Pause and resume
    subManager.pause();
    subManager.resume();

    // Wait for async re-subscription
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have sent subscribe messages again
    expect(mockTransport.sentMessages.length).toBeGreaterThan(messageCountBeforePause);

    // Check that a re-subscribe message was sent
    const resubscribeMessages = mockTransport.sentMessages.filter(
      (msg) => msg.method === 'subscribe' && (msg.params as any).subId === subId,
    );
    expect(resubscribeMessages.length).toBeGreaterThan(1);

    await subManager.unsubscribe(mintUrl, subId);
  });

  it('should allow new subscriptions after resume', async () => {
    const mintUrl = 'https://mint.example.com';

    subManager.pause();
    subManager.resume();

    // Should be able to subscribe again
    const { subId } = await subManager.subscribe(mintUrl, 'bolt11_mint_quote', ['quote1']);

    expect(subId).toBeDefined();
    await subManager.unsubscribe(mintUrl, subId);
  });

  it('should handle pause with multiple active subscriptions', async () => {
    const mintUrl1 = 'https://mint1.example.com';
    const mintUrl2 = 'https://mint2.example.com';

    const { subId: subId1 } = await subManager.subscribe(mintUrl1, 'bolt11_mint_quote', ['quote1']);
    const { subId: subId2 } = await subManager.subscribe(mintUrl2, 'bolt11_melt_quote', ['quote2']);

    const messageCountBeforePause = mockTransport.sentMessages.length;

    subManager.pause();
    subManager.resume();

    // Wait for async re-subscription
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have re-subscribed both
    expect(mockTransport.sentMessages.length).toBeGreaterThan(messageCountBeforePause);

    await subManager.unsubscribe(mintUrl1, subId1);
    await subManager.unsubscribe(mintUrl2, subId2);
  });

  it('should handle multiple pause/resume cycles', async () => {
    const mintUrl = 'https://mint.example.com';

    const { subId } = await subManager.subscribe(mintUrl, 'bolt11_mint_quote', ['quote1']);

    subManager.pause();
    subManager.resume();

    await new Promise((resolve) => setTimeout(resolve, 50));

    subManager.pause();
    subManager.resume();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should still work
    expect(mockTransport.resumed).toBe(true);

    await subManager.unsubscribe(mintUrl, subId);
  });

  it('should not re-subscribe after pause if subscription was unsubscribed', async () => {
    const mintUrl = 'https://mint.example.com';

    const { subId } = await subManager.subscribe(mintUrl, 'bolt11_mint_quote', ['quote1']);

    // Unsubscribe before pause
    await subManager.unsubscribe(mintUrl, subId);

    const messageCountAfterUnsub = mockTransport.sentMessages.length;

    subManager.pause();
    subManager.resume();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should not have sent additional subscribe messages for the unsubscribed sub
    const newSubscribes = mockTransport.sentMessages
      .slice(messageCountAfterUnsub)
      .filter((msg) => msg.method === 'subscribe' && (msg.params as any).subId === subId);
    expect(newSubscribes.length).toBe(0);
  });

  it('should handle pause with no active subscriptions', () => {
    subManager.pause();
    subManager.resume();

    // Should not error
    expect(mockTransport.resumed).toBe(true);
  });
});
