import { describe, it, beforeEach, expect } from 'bun:test';
import { MintQuoteService } from '../services/MintQuoteService';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { MintQuoteRepository } from '../repositories';
import type { MintQuote } from '../models/MintQuote';
import type { MintQuoteResponse } from '@cashu/cashu-ts';

describe('MintQuoteService.addExistingMintQuotes', () => {
  let service: MintQuoteService;
  let mockRepo: MintQuoteRepository;
  let eventBus: EventBus<CoreEvents>;
  let emittedEvents: Array<{ event: string; payload: any }>;
  let repoQuotes: Map<string, MintQuote>;

  beforeEach(() => {
    repoQuotes = new Map();
    emittedEvents = [];

    // Mock repository
    mockRepo = {
      async getMintQuote(mintUrl: string, quoteId: string): Promise<MintQuote | null> {
        const key = `${mintUrl}::${quoteId}`;
        return repoQuotes.get(key) || null;
      },
      async addMintQuote(quote: MintQuote): Promise<void> {
        const key = `${quote.mintUrl}::${quote.quote}`;
        if (repoQuotes.has(key)) {
          throw new Error('Quote already exists');
        }
        repoQuotes.set(key, quote);
      },
      async setMintQuoteState(): Promise<void> {
        // Not used in these tests
      },
      async getPendingMintQuotes(): Promise<MintQuote[]> {
        // Not used in these tests
        return [];
      },
    };

    // Create event bus with tracking
    eventBus = new EventBus<CoreEvents>();
    eventBus.on('mint-quote:added', (payload) => {
      emittedEvents.push({ event: 'mint-quote:added', payload });
    });

    // Create service
    service = new MintQuoteService(
      mockRepo,
      {} as any, // walletService not needed
      {} as any, // proofService not needed
      eventBus,
      undefined, // logger
    );
  });

  it('adds new quotes and emits events', async () => {
    const quotes: MintQuoteResponse[] = [
      {
        quote: 'quote1',
        amount: 100,
        state: 'PAID',
        request: 'lnbc100...',
      } as MintQuoteResponse,
      {
        quote: 'quote2',
        amount: 200,
        state: 'ISSUED',
        request: 'lnbc200...',
      } as MintQuoteResponse,
    ];

    const result = await service.addExistingMintQuotes('https://mint.test', quotes);

    // Both should be added
    expect(result.added).toEqual(['quote1', 'quote2']);
    expect(result.skipped).toEqual([]);

    // Check repository
    expect(repoQuotes.size).toBe(2);
    expect(repoQuotes.has('https://mint.test::quote1')).toBe(true);
    expect(repoQuotes.has('https://mint.test::quote2')).toBe(true);

    // Check events were emitted
    expect(emittedEvents.length).toBe(2);
    expect(emittedEvents[0]?.payload.quoteId).toBe('quote1');
    expect(emittedEvents[0]?.payload.quote.state).toBe('PAID');
    expect(emittedEvents[1]?.payload.quoteId).toBe('quote2');
    expect(emittedEvents[1]?.payload.quote.state).toBe('ISSUED');
  });

  it('skips quotes that already exist', async () => {
    // Pre-add a quote
    await mockRepo.addMintQuote({
      mintUrl: 'https://mint.test',
      quote: 'existing',
      amount: 50,
      state: 'ISSUED',
      request: 'lnbc50...',
      expiry: Math.floor(Date.now() / 1000) + 1000,
      unit: 'sat',
    });

    const quotes: MintQuoteResponse[] = [
      {
        quote: 'existing',
        amount: 50,
        state: 'PAID', // Different state, but still skipped
        request: 'lnbc50...',
      } as MintQuoteResponse,
      {
        quote: 'new',
        amount: 100,
        state: 'PAID',
        request: 'lnbc100...',
      } as MintQuoteResponse,
    ];

    const result = await service.addExistingMintQuotes('https://mint.test', quotes);

    // Only new quote should be added
    expect(result.added).toEqual(['new']);
    expect(result.skipped).toEqual(['existing']);

    // Check repository
    expect(repoQuotes.size).toBe(2);

    // Only one event for the new quote
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]?.payload.quoteId).toBe('new');
  });

  it('handles empty quote array', async () => {
    const result = await service.addExistingMintQuotes('https://mint.test', []);

    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(emittedEvents.length).toBe(0);
  });

  it('handles repository errors gracefully', async () => {
    // Mock repo to fail on second quote
    let callCount = 0;
    mockRepo.addMintQuote = async (quote: MintQuote) => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Database error');
      }
      const key = `${quote.mintUrl}::${quote.quote}`;
      repoQuotes.set(key, quote);
    };

    const quotes: MintQuoteResponse[] = [
      {
        quote: 'quote1',
        amount: 100,
        state: 'PAID',
        request: 'lnbc100...',
      } as MintQuoteResponse,
      {
        quote: 'quote2',
        amount: 200,
        state: 'PAID',
        request: 'lnbc200...',
      } as MintQuoteResponse,
      {
        quote: 'quote3',
        amount: 300,
        state: 'ISSUED',
        request: 'lnbc300...',
      } as MintQuoteResponse,
    ];

    const result = await service.addExistingMintQuotes('https://mint.test', quotes);

    // First and third should succeed, second should be skipped
    expect(result.added).toEqual(['quote1', 'quote3']);
    expect(result.skipped).toEqual(['quote2']);

    // Check events
    expect(emittedEvents.length).toBe(2);
    expect(emittedEvents.map((e) => e.payload.quoteId)).toEqual(['quote1', 'quote3']);
  });

  it('correctly passes quote data in events', async () => {
    const quote: MintQuoteResponse = {
      quote: 'detailed-quote',
      amount: 1000,
      state: 'PAID',
      request: 'lnbc1000...',
      expiry: 3600,
    } as MintQuoteResponse;

    await service.addExistingMintQuotes('https://mint.test', [quote]);

    // Check the event has all the quote data
    expect(emittedEvents.length).toBe(1);
    const event = emittedEvents[0];
    expect(event?.payload).toEqual({
      mintUrl: 'https://mint.test',
      quoteId: 'detailed-quote',
      quote: {
        quote: 'detailed-quote',
        amount: 1000,
        state: 'PAID',
        request: 'lnbc1000...',
        expiry: 3600,
      },
    });
  });

  it('processes multiple mints correctly', async () => {
    const mint1Quotes: MintQuoteResponse[] = [
      {
        quote: 'mint1-quote',
        amount: 100,
        state: 'PAID',
        request: 'lnbc100...',
      } as MintQuoteResponse,
    ];

    const mint2Quotes: MintQuoteResponse[] = [
      {
        quote: 'mint2-quote',
        amount: 200,
        state: 'ISSUED',
        request: 'lnbc200...',
      } as MintQuoteResponse,
    ];

    const result1 = await service.addExistingMintQuotes('https://mint1.test', mint1Quotes);
    const result2 = await service.addExistingMintQuotes('https://mint2.test', mint2Quotes);

    expect(result1.added).toEqual(['mint1-quote']);
    expect(result2.added).toEqual(['mint2-quote']);

    // Check both are in repo with correct mint URLs
    expect(repoQuotes.has('https://mint1.test::mint1-quote')).toBe(true);
    expect(repoQuotes.has('https://mint2.test::mint2-quote')).toBe(true);

    // Check events have correct mint URLs
    expect(emittedEvents[0]?.payload.mintUrl).toBe('https://mint1.test');
    expect(emittedEvents[1]?.payload.mintUrl).toBe('https://mint2.test');
  });
});
