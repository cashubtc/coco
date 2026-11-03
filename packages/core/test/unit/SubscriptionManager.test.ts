import { Amount } from '@cashu/cashu-ts';
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SubscriptionManager } from '../../infra/SubscriptionManager';
import { PollingTransport } from '../../infra/PollingTransport';
import type { RealTimeTransport } from '../../infra/RealTimeTransport';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { WsRequest } from '../../infra/SubscriptionProtocol';
import { NullLogger } from '../../logging';
import type { Logger } from '../../logging';

// Mock MintAdapter for testing
const createMockMintAdapter = (): MintAdapter =>
  ({
    checkMintQuote: mock(() => Promise.resolve({})),
    checkMeltQuote: mock(() => Promise.resolve({})),
    checkProofStates: mock(() => Promise.resolve([])),
  }) as unknown as MintAdapter;

class MockTransport implements RealTimeTransport {
  public sentMessages: WsRequest[] = [];
  public rejectSubscribes = false;
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
          ...(this.rejectSubscribes
            ? { error: { code: -32602, message: 'unsupported kind' } }
            : { result: { status: 'OK', subId: (req.params as any).subId } }),
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

  closeMint(mintUrl: string): void {
    this.listeners.delete(mintUrl);
  }

  ensure(): void {
    // Simulate socket reconnection by triggering 'open' events for all mints with listeners
    for (const [mintUrl, eventMap] of this.listeners.entries()) {
      const openListeners = eventMap.get('open');
      if (openListeners && openListeners.size > 0) {
        queueMicrotask(() => {
          for (const listener of openListeners) {
            listener({ type: 'open' });
          }
        });
      }
    }
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

describe('SubscriptionManager', () => {
  let mockTransport: MockTransport;
  let subManager: SubscriptionManager;

  beforeEach(() => {
    mockTransport = new MockTransport();
    subManager = new SubscriptionManager(mockTransport, createMockMintAdapter(), new NullLogger());
  });

  it('keeps logical subscriptions active when a subscribe request is rejected', async () => {
    const mintUrl = 'https://mint.example.com';
    mockTransport.rejectSubscribes = true;

    const { subId } = await subManager.subscribe(mintUrl, 'onchain_mint_quote', ['quote1']);
    await new Promise((resolve) => setTimeout(resolve, 10));

    mockTransport.triggerMessage(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: {
        subId,
        payload: {
          quote: 'quote1',
          request: 'bc1ptest',
          unit: 'sat',
          expiry: null,
          pubkey: 'pubkey-1',
          amount_paid: 10,
          amount_issued: 0,
        },
      },
    });

    const subscriptions = (subManager as any).subscriptions as Map<string, unknown>;
    const activeByMint = (subManager as any).activeByMint as Map<string, Set<string>>;
    expect(subscriptions.has(subId)).toBe(true);
    expect(activeByMint.get(mintUrl)?.has(subId)).toBe(true);

    await subManager.unsubscribe(mintUrl, subId);
  });

  it('normalizes raw BOLT11 quote notifications through cashu-ts before delivery', async () => {
    const mintUrl = 'https://mint.example.com';
    const normalized = {
      method: 'bolt11' as const,
      quote: 'quote1',
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: null,
      state: 'PAID' as const,
      amount_paid: Amount.from(10),
      amount_issued: Amount.zero(),
      updated_at: null,
    };
    const checkMintQuote = mock(async () => normalized);
    subManager = new SubscriptionManager(
      mockTransport,
      { checkMintQuote } as unknown as MintAdapter,
      new NullLogger(),
    );
    let receivePayload: (payload: typeof normalized) => void = () => {};
    const receivedPayload = new Promise<typeof normalized>((resolve) => {
      receivePayload = resolve;
    });

    const { subId } = await subManager.subscribe<typeof normalized>(
      mintUrl,
      'bolt11_mint_quote',
      ['quote1'],
      receivePayload,
    );
    mockTransport.triggerMessage(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: {
        subId,
        payload: {
          quote: 'quote1',
          request: 'lnbc1test',
          amount: 10,
          unit: 'sat',
          amount_paid: 10,
          amount_issued: 0,
        },
      },
    });

    await expect(receivedPayload).resolves.toBe(normalized);
    expect(checkMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', 'quote1');

    await subManager.unsubscribe(mintUrl, subId);
  });

  it('delivers normalized polling BOLT11 notifications without refetching them', async () => {
    const mintUrl = 'https://mint.example.com';
    const normalized = {
      method: 'bolt11' as const,
      quote: 'quote1',
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: null,
      state: 'PAID' as const,
      amount_paid: Amount.from(10),
      amount_issued: Amount.zero(),
      updated_at: null,
    };
    const checkMintQuote = mock(async () => normalized);
    const mintAdapter = { checkMintQuote } as unknown as MintAdapter;
    const pollingTransport = new PollingTransport(
      mintAdapter,
      { intervalMs: 5_000 },
      new NullLogger(),
    );
    subManager = new SubscriptionManager(pollingTransport, mintAdapter, new NullLogger());
    let receivePayload: (payload: typeof normalized) => void = () => {};
    const receivedPayload = new Promise<typeof normalized>((resolve) => {
      receivePayload = resolve;
    });

    const { unsubscribe } = await subManager.subscribe<typeof normalized>(
      mintUrl,
      'bolt11_mint_quote',
      ['quote1'],
      receivePayload,
    );

    await expect(receivedPayload).resolves.toBe(normalized);
    expect(checkMintQuote).toHaveBeenCalledTimes(1);

    await unsubscribe();
    pollingTransport.closeAll();
  });

  it('drops a raw BOLT11 quote notification when normalization finishes after unsubscribe', async () => {
    const mintUrl = 'https://mint.example.com';
    const normalized = {
      method: 'bolt11' as const,
      quote: 'quote1',
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: null,
      state: 'PAID' as const,
      amount_paid: Amount.from(10),
      amount_issued: Amount.zero(),
      updated_at: null,
    };
    let resolveNormalization!: (quote: typeof normalized) => void;
    const pendingNormalization = new Promise<typeof normalized>((resolve) => {
      resolveNormalization = resolve;
    });
    const checkMintQuote = mock(() => pendingNormalization);
    const callback = mock(() => {});
    subManager = new SubscriptionManager(
      mockTransport,
      { checkMintQuote } as unknown as MintAdapter,
      new NullLogger(),
    );

    const { subId, unsubscribe } = await subManager.subscribe(
      mintUrl,
      'bolt11_mint_quote',
      ['quote1'],
      callback,
    );
    mockTransport.triggerMessage(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { subId, payload: { quote: 'quote1' } },
    });
    expect(checkMintQuote).toHaveBeenCalledTimes(1);

    await unsubscribe();
    resolveNormalization(normalized);
    await pendingNormalization;
    await Promise.resolve();

    expect(callback).not.toHaveBeenCalled();
  });

  it('logs a synchronous callback failure and delivers to sibling subscribers', async () => {
    const mintUrl = 'https://mint.example.com';
    const callbackError = new Error('callback failed');
    const error = mock(() => {});
    const logger = {
      error,
      warn: mock(() => {}),
      info: mock(() => {}),
      debug: mock(() => {}),
    } satisfies Logger;
    subManager = new SubscriptionManager(mockTransport, createMockMintAdapter(), logger);
    const failingCallback = mock(() => {
      throw callbackError;
    });
    const healthyCallback = mock(() => {});

    const first = await subManager.subscribe(
      mintUrl,
      'onchain_mint_quote',
      ['quote1'],
      failingCallback,
    );
    const second = await subManager.subscribe(
      mintUrl,
      'onchain_mint_quote',
      ['quote1'],
      healthyCallback,
    );
    mockTransport.triggerMessage(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { subId: first.subId, payload: { quote: 'quote1' } },
    });
    await Promise.resolve();

    expect(healthyCallback).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('Subscription callback error', {
      mintUrl,
      subId: first.subId,
      err: callbackError,
    });

    await first.unsubscribe();
    await second.unsubscribe();
  });

  it('preserves an injected transport after closeAll', async () => {
    const mintUrl = 'https://mint.example.com';

    await subManager.subscribe(mintUrl, 'bolt11_mint_quote', ['quote1']);
    expect(mockTransport.sentMessages.some((message) => message.method === 'subscribe')).toBe(true);

    subManager.closeAll();
    const messageCountAfterClose = mockTransport.sentMessages.length;

    await subManager.subscribe(mintUrl, 'bolt11_mint_quote', ['quote2']);

    const messagesAfterClose = mockTransport.sentMessages.slice(messageCountAfterClose);
    expect(messagesAfterClose.some((message) => message.method === 'subscribe')).toBe(true);
  });
});
