import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { MintOperationProcessor } from '../../services/watchers/MintOperationProcessor';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintOperationService } from '../../operations/mint/MintOperationService';
import { MintOperationError, NetworkError } from '../../models/Error';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('MintOperationProcessor', () => {
  let bus: EventBus<CoreEvents>;
  let processor: MintOperationProcessor;
  let mockMintOperationService: MintOperationService;
  let finalizeCalls: string[];
  let claimCalls: Array<{ mintUrl: string; method: string; quoteId: string }>;
  let startupClaimCalls: number;

  const TEST_PROCESS_INTERVAL = 50;
  const TEST_RETRY_DELAY = 100;
  const TEST_INITIAL_DELAY = 10;

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
      async claimPendingMintQuotes() {
        startupClaimCalls++;
        return [];
      },
    } as unknown as MintOperationService;

    processor = new MintOperationProcessor(mockMintOperationService, bus, undefined, {
      processIntervalMs: TEST_PROCESS_INTERVAL,
      baseRetryDelayMs: TEST_RETRY_DELAY,
      maxRetries: 3,
      initialEnqueueDelayMs: TEST_INITIAL_DELAY,
    });
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

  it('processes PAID operations from mint-quote:updated', async () => {
    await processor.start();

    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      quoteId: 'quote-1',
      quote: {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'quote-1',
        quote: 'quote-1',
        state: 'PAID',
      } as any,
    });

    await sleep(TEST_PROCESS_INTERVAL * 2 + 50);

    expect(finalizeCalls).toEqual(['mint-op-1']);
  });

  it('processes all pending operations that share a paid quote', async () => {
    mockMintOperationService = {
      async getOperationsForQuote() {
        return [
          {
            id: 'mint-op-a',
            state: 'pending',
            mintUrl: 'https://mint.test',
            method: 'bolt11',
          },
          {
            id: 'mint-op-b',
            state: 'pending',
            mintUrl: 'https://mint.test',
            method: 'bolt11',
          },
        ];
      },
      async finalize(operationId: string) {
        finalizeCalls.push(operationId);
      },
    } as unknown as MintOperationService;

    processor = new MintOperationProcessor(mockMintOperationService, bus, undefined, {
      processIntervalMs: TEST_PROCESS_INTERVAL,
      baseRetryDelayMs: TEST_RETRY_DELAY,
      maxRetries: 3,
      initialEnqueueDelayMs: TEST_INITIAL_DELAY,
    });

    await processor.start();

    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      quoteId: 'shared-quote',
      quote: {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'shared-quote',
        quote: 'shared-quote',
        state: 'PAID',
      } as any,
    });

    await sleep(TEST_PROCESS_INTERVAL * 2 + 50);

    expect(finalizeCalls).toEqual(['mint-op-a', 'mint-op-b']);
  });

  it('claims reusable onchain quotes directly from mint-quote:updated', async () => {
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

  it('claims pending reusable mint quotes on startup', async () => {
    await processor.start();
    await processor.waitForCompletion();

    expect(startupClaimCalls).toBe(1);
  });

  it('can disable reusable mint quote auto-claiming', async () => {
    processor = new MintOperationProcessor(mockMintOperationService, bus, undefined, {
      processIntervalMs: TEST_PROCESS_INTERVAL,
      baseRetryDelayMs: TEST_RETRY_DELAY,
      maxRetries: 3,
      initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      autoClaimMintQuotes: false,
    });

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

  it('processes already-paid pending operations from mint-op:pending', async () => {
    await processor.start();

    await bus.emit('mint-op:pending', {
      mintUrl: 'https://mint.test',
      operationId: 'mint-op-2',
      operation: {
        id: 'mint-op-2',
        state: 'pending',
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        lastObservedRemoteState: 'PAID',
      } as any,
    });

    await sleep(TEST_PROCESS_INTERVAL + 20);

    expect(finalizeCalls).toEqual(['mint-op-2']);
  });

  it('processes explicit mint-op:requeue events', async () => {
    await processor.start();

    await bus.emit('mint-op:requeue', {
      mintUrl: 'https://mint.test',
      operationId: 'mint-op-3',
      operation: {
        id: 'mint-op-3',
        mintUrl: 'https://mint.test',
        method: 'bolt11',
      } as any,
    });

    await sleep(TEST_PROCESS_INTERVAL + 20);

    expect(finalizeCalls).toEqual(['mint-op-3']);
  });

  it('ignores non-PAID quote updates', async () => {
    await processor.start();

    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      quoteId: 'quote-4',
      quote: {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'quote-4',
        quote: 'quote-4',
        state: 'UNPAID',
      } as any,
    });

    await sleep(TEST_PROCESS_INTERVAL + 20);

    expect(finalizeCalls).toEqual([]);
  });

  it('deduplicates repeated enqueue requests for the same operation', async () => {
    await processor.start();

    for (let i = 0; i < 3; i++) {
      await bus.emit('mint-quote:updated', {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'quote-5',
        quote: {
          mintUrl: 'https://mint.test',
          method: 'bolt11',
          quoteId: 'quote-5',
          quote: 'quote-5',
          state: 'PAID',
        } as any,
      });
    }

    await sleep(TEST_PROCESS_INTERVAL + 20);

    expect(finalizeCalls).toEqual(['mint-op-5']);
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

    processor = new MintOperationProcessor(mockMintOperationService, bus, undefined, {
      processIntervalMs: TEST_PROCESS_INTERVAL,
      baseRetryDelayMs: TEST_RETRY_DELAY,
      maxRetries: 3,
      initialEnqueueDelayMs: TEST_INITIAL_DELAY,
    });

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

    processor = new MintOperationProcessor(mockMintOperationService, bus, undefined, {
      processIntervalMs: TEST_PROCESS_INTERVAL,
      baseRetryDelayMs: TEST_RETRY_DELAY,
      maxRetries: 3,
      initialEnqueueDelayMs: TEST_INITIAL_DELAY,
    });

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
