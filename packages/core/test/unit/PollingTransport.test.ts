import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PollingTransport } from '../../infra/PollingTransport';
import type { MintAdapter } from '../../infra/MintAdapter';
import { NullLogger } from '../../logging';

// Mock MintAdapter for testing
const createMockMintAdapter = (): MintAdapter =>
  ({
    checkMintQuoteState: mock(() => Promise.resolve({})),
    checkMintQuoteOnchain: mock(() => Promise.resolve({})),
    checkMeltQuoteState: mock(() => Promise.resolve({})),
    checkProofStates: mock(() => Promise.resolve([])),
  }) as unknown as MintAdapter;

// Helper to create a delayed mock adapter
const createDelayedMockMintAdapter = (delayMs: number): MintAdapter =>
  ({
    checkMintQuoteState: mock(
      () => new Promise((resolve) => setTimeout(() => resolve({ state: 'PAID' }), delayMs)),
    ),
    checkMintQuoteOnchain: mock(() => Promise.resolve({})),
    checkMeltQuoteState: mock(() => Promise.resolve({})),
    checkProofStates: mock(() => Promise.resolve([])),
  }) as unknown as MintAdapter;

describe('PollingTransport per-mint intervals', () => {
  let transport: PollingTransport;
  let mockMintAdapter: MintAdapter;
  const mintUrl1 = 'https://mint1.example.com';
  const mintUrl2 = 'https://mint2.example.com';

  beforeEach(() => {
    mockMintAdapter = createMockMintAdapter();
    transport = new PollingTransport(mockMintAdapter, { intervalMs: 5000 }, new NullLogger());
  });

  it('should use default interval when no per-mint interval is set', () => {
    // Access private method via casting for testing
    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(5000);
  });

  it('should use per-mint interval when set', () => {
    transport.setIntervalForMint(mintUrl1, 1000);

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(1000);
  });

  it('should not affect other mints when setting per-mint interval', () => {
    transport.setIntervalForMint(mintUrl1, 1000);

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(1000);
    expect(getInterval(mintUrl2)).toBe(5000); // Default
  });

  it('should allow updating per-mint interval', () => {
    transport.setIntervalForMint(mintUrl1, 1000);
    transport.setIntervalForMint(mintUrl1, 2000);

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(2000);
  });

  it('should clear per-mint interval on closeMint', () => {
    transport.setIntervalForMint(mintUrl1, 1000);
    transport.closeMint(mintUrl1);

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(5000); // Back to default
  });

  it('should clear all per-mint intervals on closeAll', () => {
    transport.setIntervalForMint(mintUrl1, 1000);
    transport.setIntervalForMint(mintUrl2, 2000);
    transport.closeAll();

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(5000); // Back to default
    expect(getInterval(mintUrl2)).toBe(5000); // Back to default
  });

  it('should support different intervals for different mints', () => {
    transport.setIntervalForMint(mintUrl1, 1000);
    transport.setIntervalForMint(mintUrl2, 3000);

    const getInterval = (transport as any).getIntervalForMint.bind(transport);
    expect(getInterval(mintUrl1)).toBe(1000);
    expect(getInterval(mintUrl2)).toBe(3000);
  });
});

describe('PollingTransport subscription kinds', () => {
  const mintUrl = 'https://mint.example.com';

  it('polls onchain mint quotes with checkMintQuoteOnchain', async () => {
    const checkMintQuoteOnchain = mock(() =>
      Promise.resolve({
        quote: 'onchain-quote-1',
        request: 'bc1ptest',
        unit: 'sat',
        expiry: null,
        pubkey: 'pubkey-1',
        amount_paid: 10,
        amount_issued: 0,
      }),
    );
    const adapter = {
      checkMintQuoteState: mock(() => Promise.resolve({})),
      checkMintQuoteOnchain,
      checkMeltQuoteState: mock(() => Promise.resolve({})),
      checkProofStates: mock(() => Promise.resolve([])),
    } as unknown as MintAdapter;
    const transport = new PollingTransport(adapter, { intervalMs: 5000 }, new NullLogger());
    const messages: any[] = [];

    transport.on(mintUrl, 'message', (evt) => {
      messages.push(JSON.parse(evt.data));
    });
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { kind: 'onchain_mint_quote', subId: 'onchain-sub-1', filters: ['quote1'] },
      id: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(checkMintQuoteOnchain).toHaveBeenCalledWith(mintUrl, 'quote1');
    expect(messages.some((message) => message.params?.payload?.quote === 'onchain-quote-1')).toBe(
      true,
    );

    transport.closeAll();
  });

  it('emits an error and does not enqueue unsupported subscription kinds', async () => {
    const adapter = createMockMintAdapter();
    const transport = new PollingTransport(adapter, { intervalMs: 5000 }, new NullLogger());
    const messages: any[] = [];

    transport.on(mintUrl, 'message', (evt) => {
      messages.push(JSON.parse(evt.data));
    });
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { kind: 'unknown_kind', subId: 'bad-sub-1', filters: ['quote1'] } as any,
      id: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(messages).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ code: -32602 }),
        id: 1,
      }),
    ]);
    const scheduler = (transport as any).schedByMint.get(mintUrl);
    expect(scheduler?.queue ?? []).toHaveLength(0);
    expect((adapter.checkMintQuoteState as any).mock.calls.length).toBe(0);

    transport.closeAll();
  });
});

describe('PollingTransport proof state batching', () => {
  const mintUrl = 'https://mint.example.com';

  it('does not duplicate a single watched proof in the checkstate request', async () => {
    const checkProofStates = mock((_: string, ys: string[]) =>
      Promise.resolve(ys.map((Y) => ({ Y, state: 'UNSPENT' }))),
    );
    const adapter = {
      checkMintQuoteState: mock(() => Promise.resolve({})),
      checkMintQuoteOnchain: mock(() => Promise.resolve({})),
      checkMeltQuoteState: mock(() => Promise.resolve({})),
      checkProofStates,
    } as unknown as MintAdapter;
    const transport = new PollingTransport(adapter, { intervalMs: 5000 }, new NullLogger());

    transport.on(mintUrl, 'message', () => {});
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { kind: 'proof_state', subId: 'proof-sub-1', filters: ['y-single'] },
      id: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(checkProofStates).toHaveBeenCalledTimes(1);
    expect(checkProofStates.mock.calls[0]?.[1]).toEqual(['y-single']);

    transport.closeAll();
  });

  it('caps proof state batches at 100 unique Ys', async () => {
    const checkProofStates = mock((_: string, ys: string[]) =>
      Promise.resolve(ys.map((Y) => ({ Y, state: 'UNSPENT' }))),
    );
    const adapter = {
      checkMintQuoteState: mock(() => Promise.resolve({})),
      checkMintQuoteOnchain: mock(() => Promise.resolve({})),
      checkMeltQuoteState: mock(() => Promise.resolve({})),
      checkProofStates,
    } as unknown as MintAdapter;
    const transport = new PollingTransport(adapter, { intervalMs: 5000 }, new NullLogger());
    const filters = Array.from({ length: 150 }, (_, index) => `y-${index}`);

    transport.on(mintUrl, 'message', () => {});
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { kind: 'proof_state', subId: 'proof-sub-2', filters },
      id: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const ys = checkProofStates.mock.calls[0]?.[1] ?? [];
    expect(ys).toHaveLength(100);
    expect(new Set(ys).size).toBe(100);

    transport.closeAll();
  });
});

describe('PollingTransport unsubscribe during processing', () => {
  const mintUrl = 'https://mint.example.com';

  it('should not re-enqueue task if unsubscribed during processing', async () => {
    // Create adapter with delay to simulate slow API call
    const delayedAdapter = createDelayedMockMintAdapter(50);
    const transport = new PollingTransport(delayedAdapter, { intervalMs: 10 }, new NullLogger());

    // Track messages received
    const messages: any[] = [];
    transport.on(mintUrl, 'message', (evt) => {
      messages.push(JSON.parse(evt.data));
    });

    // Subscribe to a quote
    const subId = 'test-sub-1';
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { kind: 'bolt11_mint_quote', subId, filters: ['quote1'] },
      id: 1,
    });

    // Wait for first poll to start (but not complete due to delay)
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Unsubscribe while the poll is in progress
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'unsubscribe',
      params: { subId },
      id: 2,
    });

    // Wait for the in-flight poll to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Check that the task was not re-enqueued
    const scheduler = (transport as any).schedByMint.get(mintUrl);
    const taskInQueue = scheduler?.queue.find((t: any) => t.subId === subId);
    expect(taskInQueue).toBeUndefined();

    // Clean up
    transport.closeAll();
  });

  it('should still re-enqueue task if not unsubscribed', async () => {
    // Track how many times checkMintQuoteState is called
    let callCount = 0;
    const countingAdapter: MintAdapter = {
      checkMintQuoteState: mock(() => {
        callCount++;
        return Promise.resolve({ state: 'UNPAID' });
      }),
      checkMintQuoteOnchain: mock(() => Promise.resolve({})),
      checkMeltQuoteState: mock(() => Promise.resolve({})),
      checkProofStates: mock(() => Promise.resolve([])),
    } as unknown as MintAdapter;

    const transport = new PollingTransport(countingAdapter, { intervalMs: 10 }, new NullLogger());

    transport.on(mintUrl, 'message', () => {});

    const subId = 'test-sub-2';
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { kind: 'bolt11_mint_quote', subId, filters: ['quote2'] },
      id: 1,
    });

    // Wait for multiple poll cycles
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should have been called multiple times (re-enqueued after each poll)
    expect(callCount).toBeGreaterThan(1);

    // Clean up
    transport.closeAll();
  });

  it('should clear unsubscribed tracking after preventing re-enqueue', async () => {
    const delayedAdapter = createDelayedMockMintAdapter(30);
    const transport = new PollingTransport(delayedAdapter, { intervalMs: 10 }, new NullLogger());

    transport.on(mintUrl, 'message', () => {});

    const subId = 'test-sub-3';
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { kind: 'bolt11_mint_quote', subId, filters: ['quote3'] },
      id: 1,
    });

    // Wait for poll to start
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Unsubscribe during processing
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'unsubscribe',
      params: { subId },
      id: 2,
    });

    // Wait for poll to complete
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The subId should be removed from the unsubscribed set after being used
    const unsubscribed = (transport as any).unsubscribedByMint.get(mintUrl);
    expect(unsubscribed?.has(subId)).toBeFalsy();

    // Clean up
    transport.closeAll();
  });
});
