import { describe, it, beforeEach, expect } from 'bun:test';
import { HistoryService } from '../services/HistoryService';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { HistoryRepository } from '../repositories';
import type { HistoryEntry, MintHistoryEntry } from '../models/History';
import type { MintQuoteResponse } from '@cashu/cashu-ts';

describe('HistoryService - mint-quote:added', () => {
  let service: HistoryService;
  let mockRepo: HistoryRepository;
  let eventBus: EventBus<CoreEvents>;
  let historyEntries: Map<string, HistoryEntry>;
  let historyUpdateEvents: Array<{ mintUrl: string; entry: HistoryEntry }>;

  beforeEach(() => {
    historyEntries = new Map();
    historyUpdateEvents = [];

    // Mock repository
    mockRepo = {
      async addHistoryEntry(entry: Omit<HistoryEntry, 'id'>): Promise<HistoryEntry> {
        const id = Math.random().toString(36).substring(7);
        const fullEntry = { ...entry, id } as HistoryEntry;
        historyEntries.set(id, fullEntry);
        return fullEntry;
      },
      async getMintHistoryEntry(
        mintUrl: string,
        quoteId: string,
      ): Promise<MintHistoryEntry | null> {
        for (const entry of historyEntries.values()) {
          if (entry.type === 'mint' && entry.mintUrl === mintUrl && entry.quoteId === quoteId) {
            return entry as MintHistoryEntry;
          }
        }
        return null;
      },
      async getPaginatedHistoryEntries(): Promise<HistoryEntry[]> {
        return Array.from(historyEntries.values());
      },
      async getMeltHistoryEntry(): Promise<null> {
        return null;
      },
      async getSendHistoryEntry(): Promise<null> {
        return null;
      },
      async getReceiveHistoryEntry(): Promise<null> {
        return null;
      },
      async updateHistoryEntryState(): Promise<void> {
        // Not used in these tests
      },
    } as HistoryRepository;

    // Create event bus
    eventBus = new EventBus<CoreEvents>();

    // Track history:updated events
    eventBus.on('history:updated', (payload) => {
      historyUpdateEvents.push(payload);
    });

    // Create service
    service = new HistoryService(mockRepo, eventBus);
  });

  it('creates history entry for added mint quote', async () => {
    const quote: MintQuoteResponse = {
      quote: 'added-quote-1',
      amount: 1000,
      state: 'UNPAID',
      request: 'lnbc1000...',
      unit: 'sat',
    } as MintQuoteResponse;

    await eventBus.emit('mint-quote:added', {
      mintUrl: 'https://mint.test',
      quoteId: 'added-quote-1',
      quote,
    });

    // Give async handler time to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Check history entry was created
    expect(historyEntries.size).toBe(1);
    const entry = Array.from(historyEntries.values())[0] as MintHistoryEntry;
    expect(entry.type).toBe('mint');
    expect(entry.mintUrl).toBe('https://mint.test');
    expect(entry.quoteId).toBe('added-quote-1');
    expect(entry.amount).toBe(1000);
    expect(entry.state).toBe('UNPAID');
    expect(entry.unit).toBe('sat');
    expect(entry.paymentRequest).toBe('lnbc1000...');

    // Check history:updated event was emitted
    expect(historyUpdateEvents.length).toBe(1);
    expect(historyUpdateEvents[0]?.mintUrl).toBe('https://mint.test');
    expect(historyUpdateEvents[0]?.entry.id).toBeDefined();
  });

  it('does not create duplicate history entry if already exists', async () => {
    // Pre-create a history entry
    await mockRepo.addHistoryEntry({
      type: 'mint',
      mintUrl: 'https://mint.test',
      quoteId: 'existing-quote',
      amount: 500,
      state: 'UNPAID',
      unit: 'sat',
      paymentRequest: 'lnbc500...',
      createdAt: Date.now(),
    });

    const quote: MintQuoteResponse = {
      quote: 'existing-quote',
      amount: 500,
      state: 'PAID', // Different state
      request: 'lnbc500...',
      unit: 'sat',
    } as MintQuoteResponse;

    await eventBus.emit('mint-quote:added', {
      mintUrl: 'https://mint.test',
      quoteId: 'existing-quote',
      quote,
    });

    // Give async handler time to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should still only have one entry
    expect(historyEntries.size).toBe(1);

    // No new history:updated event should be emitted
    expect(historyUpdateEvents.length).toBe(0);
  });

  it('creates history entries for PAID quotes', async () => {
    const quote: MintQuoteResponse = {
      quote: 'paid-quote',
      amount: 2000,
      state: 'PAID',
      request: 'lnbc2000...',
      unit: 'sat',
    } as MintQuoteResponse;

    await eventBus.emit('mint-quote:added', {
      mintUrl: 'https://mint.test',
      quoteId: 'paid-quote',
      quote,
    });

    // Give async handler time to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Check history entry was created with PAID state
    expect(historyEntries.size).toBe(1);
    const entry = Array.from(historyEntries.values())[0] as MintHistoryEntry;
    expect(entry.state).toBe('PAID');
    expect(entry.amount).toBe(2000);
  });

  it('creates history entries for ISSUED quotes', async () => {
    const quote: MintQuoteResponse = {
      quote: 'issued-quote',
      amount: 3000,
      state: 'ISSUED',
      request: 'lnbc3000...',
      unit: 'sat',
    } as MintQuoteResponse;

    await eventBus.emit('mint-quote:added', {
      mintUrl: 'https://mint.test',
      quoteId: 'issued-quote',
      quote,
    });

    // Give async handler time to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Check history entry was created with ISSUED state
    expect(historyEntries.size).toBe(1);
    const entry = Array.from(historyEntries.values())[0] as MintHistoryEntry;
    expect(entry.state).toBe('ISSUED');
    expect(entry.amount).toBe(3000);
  });

  it('handles multiple mints correctly', async () => {
    const quote1: MintQuoteResponse = {
      quote: 'mint1-quote',
      amount: 100,
      state: 'PAID',
      request: 'lnbc100...',
      unit: 'sat',
    } as MintQuoteResponse;

    const quote2: MintQuoteResponse = {
      quote: 'mint2-quote',
      amount: 200,
      state: 'UNPAID',
      request: 'lnbc200...',
      unit: 'sat',
    } as MintQuoteResponse;

    await eventBus.emit('mint-quote:added', {
      mintUrl: 'https://mint1.test',
      quoteId: 'mint1-quote',
      quote: quote1,
    });

    await eventBus.emit('mint-quote:added', {
      mintUrl: 'https://mint2.test',
      quoteId: 'mint2-quote',
      quote: quote2,
    });

    // Give async handlers time to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have two entries
    expect(historyEntries.size).toBe(2);

    // Check both entries have correct mint URLs
    const entries = Array.from(historyEntries.values()) as MintHistoryEntry[];
    const mint1Entry = entries.find((e) => e.quoteId === 'mint1-quote');
    const mint2Entry = entries.find((e) => e.quoteId === 'mint2-quote');

    expect(mint1Entry?.mintUrl).toBe('https://mint1.test');
    expect(mint1Entry?.amount).toBe(100);
    expect(mint2Entry?.mintUrl).toBe('https://mint2.test');
    expect(mint2Entry?.amount).toBe(200);

    // Should have emitted two history:updated events
    expect(historyUpdateEvents.length).toBe(2);
  });
});
