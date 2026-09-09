import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { MintOperationProcessor } from '../../services/watchers/MintOperationProcessor';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintOperationService } from '../../operations/mint/MintOperationService';
import { MintOperationError, NetworkError } from '../../models/Error';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('MintOperationProcessor', () => {
  let bus: EventBus<CoreEvents>;
  let processor: MintOperationProcessor;
  let mockMintOperationService: MintOperationService;
  let mockQuoteLifecycle: QuoteLifecycle;
  let finalizeCalls: string[];
  let claimCalls: Array<{ mintUrl: string; method: string; quoteId: string }>;
  let startupClaimCalls: number;

  const TEST_PROCESS_INTERVAL = 50;
  const TEST_RETRY_DELAY = 100;
  const TEST_INITIAL_DELAY = 10;

  const makeBolt11Quote = (quoteId: string, paid: boolean) => ({
    mintUrl: 'https://mint.test',
    method: 'bolt11' as const,
    quoteId,
    quote: quoteId,
    request: 'lnbc1test',
    amount: Amount.from(10),
    unit: 'sat',
    expiry: null,
    // Deliberately contradictory: processor decisions must use canonical accounting.
    state: paid ? ('UNPAID' as const) : ('PAID' as const),
    reusable: false as const,
    amountPaid: paid ? Amount.from(10) : Amount.zero(),
    amountIssued: Amount.zero(),
    remoteUpdatedAt: null,
    quoteData: { amount: Amount.from(10) },
    createdAt: 0,
    updatedAt: 0,
  });

  beforeEach(() => {
    bus = new EventBus<CoreEvents>();
    finalizeCalls = [];
    claimCalls = [];
    startupClaimCalls = 0;

    mockMintOperationService = {
      async getOperationsForQuote(_mintUrl: string, _method: string, quoteId: string) {
        return [
          {
            id: quoteId.replace('quote', 'mint-op'),
            state: 'pending',
            mintUrl: 'https://mint.test',
            method: 'bolt11',
          },
        ];
      },
      async finalize(operationId: string) {
        finalizeCalls.push(operationId);
      },
      async claimMintQuote(mintUrl: string, method: string, quoteId: string) {
        claimCalls.push({ mintUrl, method, quoteId });
        return [];
      },
      async getMintQuoteClaimability() {
        return { status: 'claimable' };
      },
      async claimPendingMintQuotes() {
        startupClaimCalls++;
        return [];
      },
    } as unknown as MintOperationService;

    mockQuoteLifecycle = {
      async getMintQuote() {
        return makeBolt11Quote('quote-2', true);
      },
    } as unknown as QuoteLifecycle;

    processor = new MintOperationProcessor(
      mockMintOperationService,
      mockQuoteLifecycle,
      bus,
      undefined,
      {
        processIntervalMs: TEST_PROCESS_INTERVAL,
        baseRetryDelayMs: TEST_RETRY_DELAY,
        maxRetries: 3,
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      },
    );
  });

  afterEach(async () => {
    if (processor.isRunning()) {
      await processor.stop();
    }
  });

  it('starts and stops correctly', async () => {
    expect(processor.isRunning()).toBe(false);

    await processor.start();
    expect(processor.isRunning()).toBe(true);

    await processor.stop();
    expect(processor.isRunning()).toBe(false);
  });

  it('claims accounting-ready BOLT11 quotes from mint-quote:updated', async () => {
    await processor.start();

    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      quoteId: 'quote-1',
      quote: makeBolt11Quote('quote-1', true),
    });

    await processor.waitForCompletion();

    expect(claimCalls).toEqual([
      { mintUrl: 'https://mint.test', method: 'bolt11', quoteId: 'quote-1' },
    ]);
    expect(finalizeCalls).toEqual([]);
  });

  it('advances complete BOLT11 quotes from mint-quote:updated', async () => {
    mockMintOperationService = {
      ...mockMintOperationService,
      async getMintQuoteClaimability() {
        return { status: 'complete' };
      },
    } as unknown as MintOperationService;
    processor = new MintOperationProcessor(
      mockMintOperationService,
      mockQuoteLifecycle,
      bus,
      undefined,
      {
        processIntervalMs: TEST_PROCESS_INTERVAL,
        baseRetryDelayMs: TEST_RETRY_DELAY,
        maxRetries: 3,
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      },
    );
    await processor.start();

    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      quoteId: 'complete-quote',
      quote: {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'complete-quote',
      } as any,
    });

    await processor.waitForCompletion();

    expect(claimCalls).toEqual([
      { mintUrl: 'https://mint.test', method: 'bolt11', quoteId: 'complete-quote' },
    ]);
  });

  it('delegates sibling selection to one common quote claim', async () => {
    mockMintOperationService = {
      async getMintQuoteClaimability() {
        return { status: 'claimable' };
      },
      async claimMintQuote(mintUrl: string, method: string, quoteId: string) {
        claimCalls.push({ mintUrl, method, quoteId });
        return [];
      },
      async claimPendingMintQuotes() {
        return [];
      },
    } as unknown as MintOperationService;

    processor = new MintOperationProcessor(
      mockMintOperationService,
      mockQuoteLifecycle,
      bus,
      undefined,
      {
        processIntervalMs: TEST_PROCESS_INTERVAL,
        baseRetryDelayMs: TEST_RETRY_DELAY,
        maxRetries: 3,
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      },
    );

    await processor.start();

    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      quoteId: 'shared-quote',
      quote: makeBolt11Quote('shared-quote', true),
    });

    await processor.waitForCompletion();

    expect(claimCalls).toEqual([
      { mintUrl: 'https://mint.test', method: 'bolt11', quoteId: 'shared-quote' },
    ]);
  });

  it('claims onchain balance quotes with locally claimable value from mint-quote:updated', async () => {
    await processor.start();

    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'onchain',
      quoteId: 'onchain-quote-1',
      quote: {
        mintUrl: 'https://mint.test',
        method: 'onchain',
        quoteId: 'onchain-quote-1',
        quote: 'onchain-quote-1',
        request: 'bc1qtest',
        unit: 'sat',
        expiry: null,
        reusable: true,
        quoteData: {
          pubkey: '02'.padEnd(66, '1'),
          amountPaid: 10,
          amountIssued: 0,
        },
      } as any,
    });

    await processor.waitForCompletion();

    expect(claimCalls).toEqual([
      { mintUrl: 'https://mint.test', method: 'onchain', quoteId: 'onchain-quote-1' },
    ]);
    expect(finalizeCalls).toEqual([]);
  });

  it('delegates zero-balance onchain updates for exact-output recovery', async () => {
    mockMintOperationService = {
      ...mockMintOperationService,
      async getMintQuoteClaimability() {
        return { status: 'waiting' };
      },
    } as unknown as MintOperationService;
    processor = new MintOperationProcessor(
      mockMintOperationService,
      mockQuoteLifecycle,
      bus,
      undefined,
      {
        processIntervalMs: TEST_PROCESS_INTERVAL,
        baseRetryDelayMs: TEST_RETRY_DELAY,
        maxRetries: 3,
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      },
    );

    await processor.start();
    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'onchain',
      quoteId: 'onchain-quote-empty',
      quote: { method: 'onchain', quoteId: 'onchain-quote-empty' } as any,
    });
    await processor.waitForCompletion();

    expect(claimCalls).toEqual([
      { mintUrl: 'https://mint.test', method: 'onchain', quoteId: 'onchain-quote-empty' },
    ]);
  });

  it('logs a failed quote reconciliation without starting another claim', async () => {
    mockMintOperationService = {
      ...mockMintOperationService,
      async claimMintQuote() {
        throw new Error('claimability check failed');
      },
    } as unknown as MintOperationService;
    processor = new MintOperationProcessor(
      mockMintOperationService,
      mockQuoteLifecycle,
      bus,
      undefined,
      {
        processIntervalMs: TEST_PROCESS_INTERVAL,
        baseRetryDelayMs: TEST_RETRY_DELAY,
        maxRetries: 3,
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      },
    );

    await processor.start();
    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'onchain',
      quoteId: 'onchain-quote-error',
      quote: { method: 'onchain', quoteId: 'onchain-quote-error' } as any,
    });
    await processor.waitForCompletion();

    expect(claimCalls).toEqual([]);
  });

  it('claims pending mint quotes through the common startup path', async () => {
    await processor.start();
    await processor.waitForCompletion();

    expect(startupClaimCalls).toBe(1);
  });

  it('can disable automatic mint quote claiming', async () => {
    processor = new MintOperationProcessor(
      mockMintOperationService,
      mockQuoteLifecycle,
      bus,
      undefined,
      {
        processIntervalMs: TEST_PROCESS_INTERVAL,
        baseRetryDelayMs: TEST_RETRY_DELAY,
        maxRetries: 3,
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
        autoClaimMintQuotes: false,
      },
    );

    await processor.start();
    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'onchain',
      quoteId: 'onchain-quote-disabled',
      quote: {
        mintUrl: 'https://mint.test',
        method: 'onchain',
        quoteId: 'onchain-quote-disabled',
        quote: 'onchain-quote-disabled',
        request: 'bc1qtest',
        unit: 'sat',
        expiry: null,
        reusable: true,
        quoteData: {
          pubkey: '02'.padEnd(66, '1'),
          amountPaid: 10,
          amountIssued: 0,
        },
      } as any,
    });
    await processor.waitForCompletion();

    expect(startupClaimCalls).toBe(0);
    expect(claimCalls).toEqual([]);
  });

  it('claims an accounting-ready quote from mint-op:pending', async () => {
    await processor.start();

    await bus.emit('mint-op:pending', {
      mintUrl: 'https://mint.test',
      operationId: 'mint-op-2',
      operation: {
        id: 'mint-op-2',
        state: 'pending',
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'quote-2',
      } as any,
    });

    await processor.waitForCompletion();

    expect(claimCalls).toEqual([
      { mintUrl: 'https://mint.test', method: 'bolt11', quoteId: 'quote-2' },
    ]);
    expect(finalizeCalls).toEqual([]);
  });

  it.each(['bolt11', 'bolt12', 'onchain'] as const)(
    'processes explicit %s mint-op:requeue events through the default handler',
    async (method) => {
      await processor.start();

      await bus.emit('mint-op:requeue', {
        mintUrl: 'https://mint.test',
        operationId: `mint-op-${method}`,
        operation: {
          id: `mint-op-${method}`,
          mintUrl: 'https://mint.test',
          method,
        } as any,
      });

      await sleep(TEST_PROCESS_INTERVAL + 20);

      expect(finalizeCalls).toEqual([`mint-op-${method}`]);
    },
  );

  it('delegates zero-balance BOLT11 updates for exact-output recovery', async () => {
    mockMintOperationService = {
      ...mockMintOperationService,
      async getMintQuoteClaimability() {
        return { status: 'waiting' };
      },
    } as unknown as MintOperationService;
    processor = new MintOperationProcessor(
      mockMintOperationService,
      mockQuoteLifecycle,
      bus,
      undefined,
      {
        processIntervalMs: TEST_PROCESS_INTERVAL,
        baseRetryDelayMs: TEST_RETRY_DELAY,
        maxRetries: 3,
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      },
    );
    await processor.start();

    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      quoteId: 'quote-4',
      quote: makeBolt11Quote('quote-4', false),
    });

    await processor.waitForCompletion();

    expect(claimCalls).toEqual([
      { mintUrl: 'https://mint.test', method: 'bolt11', quoteId: 'quote-4' },
    ]);
    expect(finalizeCalls).toEqual([]);
  });

  it('coalesces quote updates during active reconciliation into one follow-up', async () => {
    let releaseAssessment!: () => void;
    const assessmentGate = new Promise<void>((resolve) => {
      releaseAssessment = resolve;
    });
    let assessmentCalls = 0;
    mockMintOperationService = {
      ...mockMintOperationService,
      async claimMintQuote(mintUrl: string, method: string, quoteId: string) {
        assessmentCalls++;
        if (assessmentCalls === 1) {
          await assessmentGate;
        }
        claimCalls.push({ mintUrl, method, quoteId });
        return [];
      },
    } as unknown as MintOperationService;
    processor = new MintOperationProcessor(
      mockMintOperationService,
      mockQuoteLifecycle,
      bus,
      undefined,
      {
        processIntervalMs: TEST_PROCESS_INTERVAL,
        baseRetryDelayMs: TEST_RETRY_DELAY,
        maxRetries: 3,
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      },
    );
    await processor.start();

    for (let i = 0; i < 3; i++) {
      await bus.emit('mint-quote:updated', {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'quote-5',
        quote: makeBolt11Quote('quote-5', true),
      });
    }

    releaseAssessment();
    await processor.waitForCompletion();

    expect(assessmentCalls).toBe(2);
    expect(claimCalls).toEqual([
      { mintUrl: 'https://mint.test', method: 'bolt11', quoteId: 'quote-5' },
      { mintUrl: 'https://mint.test', method: 'bolt11', quoteId: 'quote-5' },
    ]);
    expect(finalizeCalls).toEqual([]);
  });

  it('retries network errors with exponential backoff', async () => {
    let attemptCount = 0;
    const attemptTimes: number[] = [];

    mockMintOperationService = {
      async finalize(operationId: string) {
        attemptCount++;
        attemptTimes.push(Date.now());
        if (attemptCount <= 2) {
          throw new NetworkError(`network failure for ${operationId}`);
        }
        finalizeCalls.push(operationId);
      },
    } as unknown as MintOperationService;

    processor = new MintOperationProcessor(
      mockMintOperationService,
      mockQuoteLifecycle,
      bus,
      undefined,
      {
        processIntervalMs: TEST_PROCESS_INTERVAL,
        baseRetryDelayMs: TEST_RETRY_DELAY,
        maxRetries: 3,
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      },
    );

    await processor.start();

    await bus.emit('mint-op:requeue', {
      mintUrl: 'https://mint.test',
      operationId: 'mint-op-network',
      operation: {
        id: 'mint-op-network',
        mintUrl: 'https://mint.test',
        method: 'bolt11',
      } as any,
    });

    await sleep(TEST_PROCESS_INTERVAL + 20);
    expect(attemptCount).toBe(1);

    await sleep(TEST_RETRY_DELAY + 50);
    expect(attemptCount).toBe(2);

    await sleep(TEST_RETRY_DELAY * 2 + 50);
    expect(attemptCount).toBe(3);
    expect(finalizeCalls).toEqual(['mint-op-network']);

    if (attemptTimes.length >= 2) {
      const firstRetryDelay = attemptTimes[1]! - attemptTimes[0]!;
      expect(firstRetryDelay).toBeGreaterThan(TEST_RETRY_DELAY - 20);
      expect(firstRetryDelay).toBeLessThan(TEST_RETRY_DELAY + 100);
    }

    if (attemptTimes.length >= 3) {
      const secondRetryDelay = attemptTimes[2]! - attemptTimes[1]!;
      expect(secondRetryDelay).toBeGreaterThan(TEST_RETRY_DELAY * 2 - 20);
      expect(secondRetryDelay).toBeLessThan(TEST_RETRY_DELAY * 2 + 100);
    }
  });

  it('does not retry mint operation errors', async () => {
    let attemptCount = 0;

    mockMintOperationService = {
      async finalize() {
        attemptCount++;
        throw new MintOperationError(10000, 'operation failed');
      },
    } as unknown as MintOperationService;

    processor = new MintOperationProcessor(
      mockMintOperationService,
      mockQuoteLifecycle,
      bus,
      undefined,
      {
        processIntervalMs: TEST_PROCESS_INTERVAL,
        baseRetryDelayMs: TEST_RETRY_DELAY,
        maxRetries: 3,
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      },
    );

    await processor.start();

    await bus.emit('mint-op:requeue', {
      mintUrl: 'https://mint.test',
      operationId: 'mint-op-error',
      operation: {
        id: 'mint-op-error',
        mintUrl: 'https://mint.test',
        method: 'bolt11',
      } as any,
    });

    await sleep(TEST_PROCESS_INTERVAL + 20);

    expect(attemptCount).toBe(1);
  });
});
