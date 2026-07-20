import { Amount } from '@cashu/cashu-ts';
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PollingTransport } from '../../infra/PollingTransport';
import type { MintAdapter } from '../../infra/MintAdapter';
import { NullLogger } from '../../logging';
import { mintQuoteFromBolt11Response } from '../../models/MintQuote.ts';
import type { QuoteIdentity } from '../../models/QuoteIdentity.ts';
import type { MintMethod } from '../../operations/mint/MintMethodHandler.ts';
import type {
  MintQuotePollingOperation,
  MintQuotePollingResult,
} from '../../quotes/MintQuotePolling.ts';
import { waitFor } from '../waitFor.ts';

function failedPollingResult(mintUrl: string, quoteIds: readonly string[]): MintQuotePollingResult {
  return {
    outcomes: quoteIds.map((quoteId) => ({
      status: 'failed',
      identity: { mintUrl, quoteId },
      failure: { category: 'network', error: new Error('offline') },
    })),
    responseFailures: [],
  };
}

function subscribeToQuotes(
  transport: PollingTransport,
  mintUrl: string,
  method: MintMethod,
  subId: string,
  quoteIds: string[],
): void {
  transport.send(mintUrl, {
    jsonrpc: '2.0',
    method: 'subscribe',
    params: { kind: `${method}_mint_quote`, subId, filters: quoteIds },
    id: 1,
  });
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

describe('PollingTransport mint quote batching', () => {
  const mintUrl = 'https://mint.example.com';
  const mintUrlVariant = 'https://MINT.example.com/';

  it('groups normalized compatible interests deterministically up to the advertised limit', async () => {
    const calls: Array<{ mintUrl: string; method: MintMethod; quoteIds: string[] }> = [];
    let transport: PollingTransport;
    const polling: MintQuotePollingOperation = {
      getMintQuotePollingLimit: mock(async () => 2),
      checkMintQuotesForPolling: mock(
        async (method: MintMethod, identities: readonly QuoteIdentity[]) => {
          calls.push({
            mintUrl: identities[0]!.mintUrl,
            method,
            quoteIds: identities.map(({ quoteId }) => quoteId),
          });
          transport.pause();
          return failedPollingResult(
            mintUrl,
            identities.map(({ quoteId }) => quoteId),
          );
        },
      ),
    };
    const adapter = createMockMintAdapter();
    transport = new PollingTransport(adapter, { intervalMs: 1 }, new NullLogger(), polling);

    transport.on(mintUrl, 'message', () => {});
    transport.pause();
    subscribeToQuotes(transport, mintUrlVariant, 'bolt11', 'bolt11-sub', [
      'quote-b',
      'quote-a',
      'quote-a',
      'quote-c',
    ]);
    subscribeToQuotes(transport, mintUrl, 'bolt12', 'bolt12-sub', ['quote-z']);
    transport.resume();
    await waitFor(() => calls.length === 1);

    expect(calls).toEqual([{ mintUrl, method: 'bolt11', quoteIds: ['quote-b', 'quote-a'] }]);
    expect(adapter.checkMintQuote).not.toHaveBeenCalled();
    transport.closeAll();
  });

  for (const method of ['bolt11', 'bolt12', 'onchain'] as const) {
    it(`batches advertised ${method} interests`, async () => {
      const calls: string[][] = [];
      let transport: PollingTransport;
      const polling: MintQuotePollingOperation = {
        getMintQuotePollingLimit: mock(async () => 100),
        checkMintQuotesForPolling: mock(
          async (_method: MintMethod, identities: readonly QuoteIdentity[]) => {
            calls.push(identities.map(({ quoteId }) => quoteId));
            transport.pause();
            return failedPollingResult(
              mintUrl,
              identities.map(({ quoteId }) => quoteId),
            );
          },
        ),
      };
      transport = new PollingTransport(
        createMockMintAdapter(),
        { intervalMs: 1 },
        new NullLogger(),
        polling,
      );

      transport.on(mintUrl, 'message', () => {});
      transport.pause();
      subscribeToQuotes(transport, mintUrl, method, `${method}-sub`, ['quote-a', 'quote-b']);
      transport.resume();
      await waitFor(() => calls.length === 1);

      expect(calls).toEqual([['quote-a', 'quote-b']]);
      transport.closeAll();
    });
  }

  it('caps observable mint quote polling requests at 100 identities', async () => {
    const calls: string[][] = [];
    let transport: PollingTransport;
    const polling: MintQuotePollingOperation = {
      getMintQuotePollingLimit: mock(async () => 100),
      checkMintQuotesForPolling: mock(
        async (_method: MintMethod, identities: readonly QuoteIdentity[]) => {
          calls.push(identities.map(({ quoteId }) => quoteId));
          transport.pause();
          return failedPollingResult(
            mintUrl,
            identities.map(({ quoteId }) => quoteId),
          );
        },
      ),
    };
    transport = new PollingTransport(
      createMockMintAdapter(),
      { intervalMs: 1 },
      new NullLogger(),
      polling,
    );
    const quoteIds = Array.from({ length: 101 }, (_, index) => `quote-${index}`);

    transport.on(mintUrl, 'message', () => {});
    transport.pause();
    subscribeToQuotes(transport, mintUrl, 'bolt11', 'capped-sub', quoteIds);
    transport.resume();
    await waitFor(() => calls.length === 1);

    expect(calls[0]).toEqual(quoteIds.slice(0, 100));
    transport.closeAll();
  });

  it('ends and requeues the turn when polling-limit resolution fails', async () => {
    const calls: string[][] = [];
    const getMintQuotePollingLimit = mock(async () => {
      if (getMintQuotePollingLimit.mock.calls.length === 1) throw new Error('metadata offline');
      return 2;
    });
    let transport: PollingTransport;
    const polling: MintQuotePollingOperation = {
      getMintQuotePollingLimit,
      checkMintQuotesForPolling: mock(
        async (_method: MintMethod, identities: readonly QuoteIdentity[]) => {
          calls.push(identities.map(({ quoteId }) => quoteId));
          transport.pause();
          return failedPollingResult(
            mintUrl,
            identities.map(({ quoteId }) => quoteId),
          );
        },
      ),
    };
    transport = new PollingTransport(
      createMockMintAdapter(),
      { intervalMs: 1 },
      new NullLogger(),
      polling,
    );

    transport.on(mintUrl, 'message', () => {});
    transport.pause();
    subscribeToQuotes(transport, mintUrl, 'bolt11', 'retry-sub', ['quote-a', 'quote-b']);
    transport.resume();
    await waitFor(() => calls.length === 1);

    expect(getMintQuotePollingLimit).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([['quote-b', 'quote-a']]);
    transport.closeAll();
  });

  it('polls unsupported methods one quote per turn', async () => {
    const calls: string[][] = [];
    let transport: PollingTransport;
    const polling: MintQuotePollingOperation = {
      getMintQuotePollingLimit: mock(async () => 1),
      checkMintQuotesForPolling: mock(
        async (_method: MintMethod, identities: readonly QuoteIdentity[]) => {
          calls.push(identities.map(({ quoteId }) => quoteId));
          if (calls.length === 2) transport.pause();
          return failedPollingResult(
            mintUrl,
            identities.map(({ quoteId }) => quoteId),
          );
        },
      ),
    };
    transport = new PollingTransport(
      createMockMintAdapter(),
      { intervalMs: 1 },
      new NullLogger(),
      polling,
    );

    transport.on(mintUrl, 'message', () => {});
    transport.pause();
    subscribeToQuotes(transport, mintUrl, 'bolt11', 'single-sub', ['quote-a', 'quote-b']);
    transport.resume();
    await waitFor(() => calls.length === 2);

    expect(calls).toEqual([['quote-a'], ['quote-b']]);
    transport.closeAll();
  });

  it('rotates requeued interests so every quote retains fair access', async () => {
    const calls: string[][] = [];
    let transport: PollingTransport;
    const polling: MintQuotePollingOperation = {
      getMintQuotePollingLimit: mock(async () => 2),
      checkMintQuotesForPolling: mock(
        async (_method: MintMethod, identities: readonly QuoteIdentity[]) => {
          calls.push(identities.map(({ quoteId }) => quoteId));
          if (calls.length === 3) transport.pause();
          return failedPollingResult(
            mintUrl,
            identities.map(({ quoteId }) => quoteId),
          );
        },
      ),
    };
    transport = new PollingTransport(
      createMockMintAdapter(),
      { intervalMs: 1 },
      new NullLogger(),
      polling,
    );

    transport.on(mintUrl, 'message', () => {});
    transport.pause();
    subscribeToQuotes(transport, mintUrl, 'bolt11', 'fair-sub', ['quote-a', 'quote-b', 'quote-c']);
    transport.resume();
    await waitFor(() => calls.length === 3);

    expect(calls).toEqual([
      ['quote-a', 'quote-b'],
      ['quote-c', 'quote-a'],
      ['quote-b', 'quote-c'],
    ]);
    transport.closeAll();
  });

  it('gives late interests fair access on the next polling turn', async () => {
    const calls: string[][] = [];
    let resolveFirst!: () => void;
    const firstCheck = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let transport: PollingTransport;
    const polling: MintQuotePollingOperation = {
      getMintQuotePollingLimit: mock(async () => 2),
      checkMintQuotesForPolling: mock(
        async (_method: MintMethod, identities: readonly QuoteIdentity[]) => {
          calls.push(identities.map(({ quoteId }) => quoteId));
          if (calls.length === 1) await firstCheck;
          if (calls.length === 2) transport.pause();
          return failedPollingResult(
            mintUrl,
            identities.map(({ quoteId }) => quoteId),
          );
        },
      ),
    };
    transport = new PollingTransport(
      createMockMintAdapter(),
      { intervalMs: 1 },
      new NullLogger(),
      polling,
    );

    transport.on(mintUrl, 'message', () => {});
    transport.pause();
    subscribeToQuotes(transport, mintUrl, 'bolt11', 'existing-sub', ['quote-a', 'quote-b']);
    transport.resume();
    await waitFor(() => calls.length === 1);

    subscribeToQuotes(transport, mintUrl, 'bolt11', 'late-sub', ['quote-c']);
    resolveFirst();
    await waitFor(() => calls.length === 2);

    expect(calls).toEqual([
      ['quote-a', 'quote-b'],
      ['quote-c', 'quote-a'],
    ]);
    transport.closeAll();
  });

  it('keeps the configured interval between requeued polling turns', async () => {
    const startedAt: number[] = [];
    let transport: PollingTransport;
    const polling: MintQuotePollingOperation = {
      getMintQuotePollingLimit: mock(async () => 1),
      checkMintQuotesForPolling: mock(
        async (_method: MintMethod, identities: readonly QuoteIdentity[]) => {
          startedAt.push(Date.now());
          if (startedAt.length === 2) transport.pause();
          return failedPollingResult(
            mintUrl,
            identities.map(({ quoteId }) => quoteId),
          );
        },
      ),
    };
    transport = new PollingTransport(
      createMockMintAdapter(),
      { intervalMs: 20 },
      new NullLogger(),
      polling,
    );

    transport.on(mintUrl, 'message', () => {});
    subscribeToQuotes(transport, mintUrl, 'bolt11', 'cadence-sub', ['quote-a']);
    await waitFor(() => startedAt.length === 2);

    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(18);
    transport.closeAll();
  });

  it('removes an in-flight interest without repolling it or corrupting siblings', async () => {
    const calls: string[][] = [];
    const messages: Array<{ params?: { subId?: string; payload?: { quote?: string } } }> = [];
    let resolveFirst!: () => void;
    const firstCheck = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let transport: PollingTransport;
    const polling: MintQuotePollingOperation = {
      getMintQuotePollingLimit: mock(async () => 2),
      checkMintQuotesForPolling: mock(
        async (_method: MintMethod, identities: readonly QuoteIdentity[]) => {
          calls.push(identities.map(({ quoteId }) => quoteId));
          if (calls.length === 1) await firstCheck;
          if (calls.length === 2) transport.pause();
          return {
            outcomes: identities.map(({ mintUrl: identityMintUrl, quoteId }) => ({
              status: 'updated' as const,
              identity: { mintUrl: identityMintUrl, quoteId },
              quote: mintQuoteFromBolt11Response(identityMintUrl, {
                quote: quoteId,
                request: `lnbc1${quoteId}`,
                amount: Amount.from(10),
                unit: 'sat',
                expiry: null,
                state: 'PAID',
              }),
            })),
            responseFailures: [],
          };
        },
      ),
    };
    transport = new PollingTransport(
      createMockMintAdapter(),
      { intervalMs: 1 },
      new NullLogger(),
      polling,
    );

    transport.on(mintUrl, 'message', (event) => messages.push(JSON.parse(event.data)));
    transport.pause();
    subscribeToQuotes(transport, mintUrl, 'bolt11', 'removed-sub', ['quote-a']);
    subscribeToQuotes(transport, mintUrl, 'bolt11', 'sibling-sub', ['quote-b']);
    transport.resume();
    await waitFor(() => calls.length === 1);

    transport.send(mintUrl, {
      jsonrpc: '2.0',
      method: 'unsubscribe',
      params: { subId: 'removed-sub' },
      id: 2,
    });
    resolveFirst();
    await waitFor(() => calls.length === 2);

    expect(calls).toEqual([['quote-a', 'quote-b'], ['quote-b']]);
    const notifications = messages.filter(({ params }) => params?.payload?.quote);
    expect(notifications).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          subId: 'sibling-sub',
          payload: expect.objectContaining({ quote: 'quote-b' }),
        }),
      }),
    );
    expect(
      notifications.some(
        ({ params }) => params?.subId === 'removed-sub' || params?.payload?.quote === 'quote-a',
      ),
    ).toBe(false);
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
