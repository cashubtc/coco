import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PollingTransport } from '../../infra/PollingTransport';
import type { MintAdapter } from '../../infra/MintAdapter';
import { NullLogger } from '../../logging';

// Mock MintAdapter for testing
const createMockMintAdapter = (): MintAdapter =>
  ({
    checkMintQuoteState: mock(() => Promise.resolve({})),
    checkMeltQuoteState: mock(() => Promise.resolve({})),
    checkProofStates: mock(() => Promise.resolve([])),
  } as unknown as MintAdapter);

// Helper to create a delayed mock adapter
const createDelayedMockMintAdapter = (delayMs: number): MintAdapter =>
  ({
    checkMintQuoteState: mock(
      () => new Promise((resolve) => setTimeout(() => resolve({ state: 'PAID' }), delayMs)),
    ),
    checkMeltQuoteState: mock(() => Promise.resolve({})),
    checkProofStates: mock(() => Promise.resolve([])),
  } as unknown as MintAdapter);

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
