import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import { PollingTransport } from '../../infra/PollingTransport';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { MintQuotePollingCheckResult } from '../../infra/MintQuotePollingChecker';
import { NullLogger } from '../../logging';

type PollingMessage = {
  method?: string;
  params?: { payload?: { quote?: string } };
};

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject } as const;
}

// Mock MintAdapter for testing
const createMockMintAdapter = (): MintAdapter =>
  ({
    checkMintQuote: mock(() => Promise.resolve({})),
    checkMeltQuoteState: mock(() => Promise.resolve({})),
    checkProofStates: mock(() => Promise.resolve([])),
  }) as unknown as MintAdapter;

// Helper to create a delayed mock adapter
const createDelayedMockMintAdapter = (delayMs: number): MintAdapter =>
  ({
    checkMintQuote: mock(
      () => new Promise((resolve) => setTimeout(() => resolve({ state: 'PAID' }), delayMs)),
    ),
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

  it('checks compatible watched mint quotes as one deterministic batch opportunity', async () => {
    const checked = createDeferred();
    const checker = {
      checkMintQuotesForPolling: mock(async (_mintUrl, _method, quoteIds: string[]) => {
        const result = {
          attemptedQuoteIds: quoteIds,
          observations: quoteIds
            .slice()
            .reverse()
            .map((quote) => ({
              quote,
              request: `${quote}-request`,
              amount: Amount.from(10),
              unit: 'sat',
              expiry: null,
              state: 'UNPAID' as const,
            })),
        };
        checked.resolve();
        return result;
      }),
    };
    const adapter = createMockMintAdapter();
    const transport = new PollingTransport(
      adapter,
      { intervalMs: 5000 },
      new NullLogger(),
      checker,
    );
    const messages: PollingMessage[] = [];
    transport.on(mintUrl, 'message', (evt) => {
      messages.push(JSON.parse(evt.data) as PollingMessage);
    });
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: {
        kind: 'bolt11_mint_quote',
        subId: 'batch-sub-1',
        filters: ['quote-1', 'quote-2', 'quote-1'],
      },
      id: 1,
    });

    await checked.promise;

    expect(checker.checkMintQuotesForPolling).toHaveBeenCalledWith(mintUrl, 'bolt11', [
      'quote-1',
      'quote-2',
    ]);
    expect(adapter.checkMintQuote).not.toHaveBeenCalled();
    const quoteUpdates = messages.filter((message) => message.method === 'subscribe');
    expect(quoteUpdates.map((message) => message.params?.payload?.quote).sort()).toEqual([
      'quote-1',
      'quote-1',
      'quote-2',
    ]);

    transport.closeAll();
  });

  it('keeps watched mint quotes eligible after a failed batch opportunity', async () => {
    const retried = createDeferred();
    const checker = {
      checkMintQuotesForPolling: mock()
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockImplementationOnce(async () => {
          retried.resolve();
          return { attemptedQuoteIds: ['quote-1'], observations: [] };
        }),
    };
    const transport = new PollingTransport(
      createMockMintAdapter(),
      { intervalMs: 1 },
      new NullLogger(),
      checker,
    );
    transport.on(mintUrl, 'message', () => {});
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { kind: 'bolt11_mint_quote', subId: 'retry-sub', filters: ['quote-1'] },
      id: 1,
    });

    await retried.promise;

    expect(checker.checkMintQuotesForPolling.mock.calls.length).toBeGreaterThanOrEqual(2);
    transport.closeAll();
  });

  it('rotates unattempted quote IDs ahead of a limited chunk', async () => {
    const secondCheck = createDeferred<string[]>();
    const checker = {
      checkMintQuotesForPolling: mock(async (_mintUrl, _method, quoteIds: string[]) => {
        if (checker.checkMintQuotesForPolling.mock.calls.length === 2) {
          secondCheck.resolve(quoteIds);
        }
        return { attemptedQuoteIds: quoteIds.slice(0, 1), observations: [] };
      }),
    };
    const transport = new PollingTransport(
      createMockMintAdapter(),
      { intervalMs: 0 },
      new NullLogger(),
      checker,
    );
    transport.on(mintUrl, 'message', () => {});
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: {
        kind: 'bolt11_mint_quote',
        subId: 'fairness-sub',
        filters: ['quote-1', 'quote-2', 'quote-3'],
      },
      id: 1,
    });

    await expect(secondCheck.promise).resolves.toEqual(['quote-2', 'quote-3']);
    transport.closeAll();
  });

  it('backs off a missing quote while other watched quotes stay eligible', async () => {
    const thirdCheck = createDeferred<string[]>();
    const checker = {
      checkMintQuotesForPolling: mock(async (_mintUrl, _method, quoteIds: string[]) => {
        const call = checker.checkMintQuotesForPolling.mock.calls.length;
        if (call === 3) thirdCheck.resolve(quoteIds);
        return call === 1
          ? { attemptedQuoteIds: ['quote-bad'], observations: [] }
          : {
              attemptedQuoteIds: quoteIds,
              observations: quoteIds.map((quote) => ({
                quote,
                request: `${quote}-request`,
                amount: Amount.from(10),
                unit: 'sat',
                expiry: null,
                state: 'UNPAID' as const,
              })),
            };
      }),
    };
    const transport = new PollingTransport(
      createMockMintAdapter(),
      { intervalMs: 0 },
      new NullLogger(),
      checker,
    );
    transport.on(mintUrl, 'message', () => {});
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: {
        kind: 'bolt11_mint_quote',
        subId: 'backoff-sub',
        filters: ['quote-bad', 'quote-good'],
      },
      id: 1,
    });

    const thirdIds = await thirdCheck.promise;
    expect(thirdIds).not.toContain('quote-bad');
    expect(thirdIds).toContain('quote-good');
    transport.closeAll();
  });

  it('polls onchain mint quotes with checkMintQuote', async () => {
    const checkMintQuote = mock(() =>
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
      checkMintQuote,
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

    expect(checkMintQuote).toHaveBeenCalledWith(mintUrl, 'onchain', 'quote1');
    expect(messages.some((message) => message.params?.payload?.quote === 'onchain-quote-1')).toBe(
      true,
    );

    transport.closeAll();
  });

  it('polls onchain melt quotes with full checkMeltQuoteOnchain responses', async () => {
    const checkMeltQuoteOnchain = mock(() =>
      Promise.resolve({
        quote: 'onchain-melt-quote-1',
        request: 'bc1ptest',
        amount: 10,
        unit: 'sat',
        expiry: 1_730_000_000,
        state: 'PENDING',
        fee_options: [{ fee_index: 0, fee_reserve: 1, estimated_blocks: 3 }],
        selected_fee_index: null,
        outpoint: null,
      }),
    );
    const adapter = {
      checkMintQuote: mock(() => Promise.resolve({})),
      checkMeltQuoteState: mock(() => Promise.resolve({})),
      checkMeltQuoteOnchain,
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
      params: { kind: 'onchain_melt_quote', subId: 'onchain-melt-sub-1', filters: ['quote1'] },
      id: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(checkMeltQuoteOnchain).toHaveBeenCalledWith(mintUrl, 'quote1');
    expect(
      messages.some((message) => message.params?.payload?.quote === 'onchain-melt-quote-1'),
    ).toBe(true);

    transport.closeAll();
  });

  it('polls every filter in a multi-filter quote subscription', async () => {
    const quoteIds = ['quote1', 'quote2', 'quote3'];
    const checkMintQuote = mock((_: string, __: string, quoteId: string) =>
      Promise.resolve({
        quote: quoteId,
        request: `${quoteId}-request`,
        amount: 10,
        unit: 'sat',
        expiry: null,
        state: 'UNPAID',
      }),
    );
    const adapter = {
      checkMintQuote,
      checkMeltQuoteState: mock(() => Promise.resolve({})),
      checkProofStates: mock(() => Promise.resolve([])),
    } as unknown as MintAdapter;
    const transport = new PollingTransport(adapter, { intervalMs: 1 }, new NullLogger());
    const messages: any[] = [];

    transport.on(mintUrl, 'message', (evt) => {
      messages.push(JSON.parse(evt.data));
    });
    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { kind: 'bolt11_mint_quote', subId: 'multi-filter-sub-1', filters: quoteIds },
      id: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    const polledQuoteIds = checkMintQuote.mock.calls.map((call) => call[2]);
    for (const quoteId of quoteIds) {
      expect(polledQuoteIds).toContain(quoteId);
    }

    const updateMessages = messages.filter((message) => message.method === 'subscribe');
    expect(updateMessages.length).toBeGreaterThanOrEqual(quoteIds.length);
    expect(updateMessages.every((message) => message.params?.subId === 'multi-filter-sub-1')).toBe(
      true,
    );

    const payloadQuoteIds = updateMessages.map((message) => message.params?.payload?.quote);
    for (const quoteId of quoteIds) {
      expect(payloadQuoteIds).toContain(quoteId);
    }

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
    expect((adapter.checkMintQuote as any).mock.calls.length).toBe(0);

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
      checkMintQuote: mock(() => Promise.resolve({})),
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
      checkMintQuote: mock(() => Promise.resolve({})),
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

  it('does not repoll sibling filters after a batched subscription is removed', async () => {
    const started = createDeferred();
    const firstResult = createDeferred<MintQuotePollingCheckResult>();
    const checker = {
      checkMintQuotesForPolling: mock(async (_mintUrl, _method, quoteIds: string[]) => {
        if (checker.checkMintQuotesForPolling.mock.calls.length === 1) {
          started.resolve();
          return firstResult.promise;
        }
        return { attemptedQuoteIds: quoteIds, observations: [] };
      }),
    };
    const transport = new PollingTransport(
      createMockMintAdapter(),
      { intervalMs: 1 },
      new NullLogger(),
      checker,
    );
    const subId = 'batched-unsubscribe-sub';
    transport.on(mintUrl, 'message', () => {});

    try {
      transport.send(mintUrl, {
        jsonrpc: '2.0',
        method: 'subscribe',
        params: {
          kind: 'bolt11_mint_quote',
          subId,
          filters: ['quote-1', 'quote-2'],
        },
        id: 1,
      });
      await started.promise;

      transport.send(mintUrl, {
        jsonrpc: '2.0',
        method: 'unsubscribe',
        params: { subId },
        id: 2,
      });
      firstResult.resolve({
        attemptedQuoteIds: ['quote-1', 'quote-2'],
        observations: ['quote-1', 'quote-2'].map((quote) => ({
          quote,
          request: `${quote}-request`,
          amount: Amount.from(10),
          unit: 'sat',
          expiry: null,
          state: 'UNPAID' as const,
        })),
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(checker.checkMintQuotesForPolling).toHaveBeenCalledTimes(1);
    } finally {
      transport.closeAll();
    }
  });

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
    // Track how many times checkMintQuote is called
    let callCount = 0;
    const countingAdapter: MintAdapter = {
      checkMintQuote: mock(() => {
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
