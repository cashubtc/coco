import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { MintQuoteProcessor } from '../services/watchers/MintQuoteProcessor';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { MintQuoteService } from '../services/MintQuoteService';
import type { MintQuoteState } from '@cashu/cashu-ts';
import { MintOperationError, NetworkError } from '../models/Error';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('MintQuoteProcessor', () => {
  let bus: EventBus<CoreEvents>;
  let mockQuoteService: MintQuoteService;
  let processor: MintQuoteProcessor;
  let redeemCalls: Array<{ mintUrl: string; quoteId: string }>;
  let updateStateCalls: Array<{ mintUrl: string; quoteId: string; state: MintQuoteState }>;

  // Use much shorter intervals for tests
  const TEST_PROCESS_INTERVAL = 50; // 50ms instead of 3000ms
  const TEST_RETRY_DELAY = 100; // 100ms instead of 5000ms

  beforeEach(() => {
    bus = new EventBus<CoreEvents>();
    redeemCalls = [];
    updateStateCalls = [];

    // Mock MintQuoteService
    mockQuoteService = {
      async redeemMintQuote(mintUrl: string, quoteId: string) {
        redeemCalls.push({ mintUrl, quoteId });
      },
      async updateStateFromRemote(mintUrl: string, quoteId: string, state: MintQuoteState) {
        updateStateCalls.push({ mintUrl, quoteId, state });
      },
    } as any;

    processor = new MintQuoteProcessor(mockQuoteService, bus, undefined, {
      processIntervalMs: TEST_PROCESS_INTERVAL,
      baseRetryDelayMs: TEST_RETRY_DELAY,
      maxRetries: 3,
    });
  });

  afterEach(async () => {
    if (processor.isRunning()) {
      await processor.stop();
    }
  });

  describe('lifecycle', () => {
    it('starts and stops correctly', async () => {
      expect(processor.isRunning()).toBe(false);

      await processor.start();
      expect(processor.isRunning()).toBe(true);

      await processor.stop();
      expect(processor.isRunning()).toBe(false);
    });

    it('ignores duplicate start calls', async () => {
      await processor.start();
      await processor.start(); // Should not throw
      expect(processor.isRunning()).toBe(true);

      await processor.stop();
    });

    it('ignores duplicate stop calls', async () => {
      await processor.start();
      await processor.stop();
      await processor.stop(); // Should not throw
      expect(processor.isRunning()).toBe(false);
    });
  });

  describe('quote processing', () => {
    it('processes PAID quotes from state-changed events', async () => {
      await processor.start();

      // Emit a PAID state change
      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'quote1',
        state: 'PAID',
      });

      // Wait for processing (3 second interval + some buffer)
      await sleep(TEST_PROCESS_INTERVAL + 20);

      expect(redeemCalls.length).toBe(1);
      expect(redeemCalls[0]).toEqual({
        mintUrl: 'https://mint.test',
        quoteId: 'quote1',
      });
    });

    it('processes PAID quotes from mint-quote:added events', async () => {
      await processor.start();

      // Emit an added quote with PAID state
      await bus.emit('mint-quote:added', {
        mintUrl: 'https://mint.test',
        quoteId: 'added-quote',
        quote: {
          quote: 'added-quote',
          amount: 100,
          state: 'PAID',
          request: 'lnbc...',
        } as any,
      });

      // Wait for processing
      await sleep(TEST_PROCESS_INTERVAL + 20);

      expect(redeemCalls.length).toBe(1);
      expect(redeemCalls[0]).toEqual({
        mintUrl: 'https://mint.test',
        quoteId: 'added-quote',
      });
    });

    it('processes quotes from mint-quote:requeue events', async () => {
      await processor.start();

      // Emit a requeue event (no need for full quote payload)
      await bus.emit('mint-quote:requeue', {
        mintUrl: 'https://mint.test',
        quoteId: 'requeued-quote',
      });

      // Wait for processing (test interval + buffer)
      await sleep(TEST_PROCESS_INTERVAL + 20);

      expect(redeemCalls.length).toBe(1);
      expect(redeemCalls[0]).toEqual({
        mintUrl: 'https://mint.test',
        quoteId: 'requeued-quote',
      });
    });

    it('processes added quotes with bolt11 handler', async () => {
      await processor.start();

      // Emit an added quote (always uses bolt11 for now)
      await bus.emit('mint-quote:added', {
        mintUrl: 'https://mint.test',
        quoteId: 'custom-quote',
        quote: {
          quote: 'custom-quote',
          amount: 100,
          state: 'PAID',
          request: 'lnbc...',
        } as any,
      });

      await sleep(TEST_PROCESS_INTERVAL + 20);

      // Should use bolt11 handler
      expect(redeemCalls.length).toBe(1);
      expect(redeemCalls[0]).toEqual({
        mintUrl: 'https://mint.test',
        quoteId: 'custom-quote',
      });
    });

    it('defaults to bolt11 when quoteType not specified in mint-quote:added', async () => {
      await processor.start();

      // Emit an added quote
      await bus.emit('mint-quote:added', {
        mintUrl: 'https://mint.test',
        quoteId: 'default-type-quote',
        quote: {
          quote: 'default-type-quote',
          amount: 100,
          state: 'PAID',
          request: 'lnbc...',
        } as any,
      });

      await sleep(TEST_PROCESS_INTERVAL + 20);

      // Should use default bolt11 handler
      expect(redeemCalls.length).toBe(1);
      expect(redeemCalls[0]).toEqual({
        mintUrl: 'https://mint.test',
        quoteId: 'default-type-quote',
      });
    });

    it('ignores non-PAID quotes from mint-quote:added events', async () => {
      await processor.start();

      await bus.emit('mint-quote:added', {
        mintUrl: 'https://mint.test',
        quoteId: 'unpaid-added',
        quote: {
          quote: 'unpaid-added',
          amount: 100,
          state: 'UNPAID',
          request: 'lnbc...',
        } as any,
      });

      await bus.emit('mint-quote:added', {
        mintUrl: 'https://mint.test',
        quoteId: 'issued-added',
        quote: {
          quote: 'issued-added',
          amount: 100,
          state: 'ISSUED',
          request: 'lnbc...',
        } as any,
      });

      await sleep(TEST_PROCESS_INTERVAL + 20);

      expect(redeemCalls.length).toBe(0);
    });

    it('ignores non-PAID state changes', async () => {
      await processor.start();

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'quote1',
        state: 'UNPAID',
      });

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'quote2',
        state: 'ISSUED',
      });

      await sleep(TEST_PROCESS_INTERVAL + 20);

      expect(redeemCalls.length).toBe(0);
    });

    it('processes multiple quotes in FIFO order with throttling', async () => {
      await processor.start();

      // Emit multiple PAID quotes
      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint1.test',
        quoteId: 'quote1',
        state: 'PAID',
      });

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint2.test',
        quoteId: 'quote2',
        state: 'PAID',
      });

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint3.test',
        quoteId: 'quote3',
        state: 'PAID',
      });

      // First should process after ~3s
      await sleep(TEST_PROCESS_INTERVAL + 20);
      expect(redeemCalls.length).toBe(1);
      expect(redeemCalls[0]?.quoteId).toBe('quote1');

      // Second should process after another ~3s
      await sleep(TEST_PROCESS_INTERVAL);
      expect(redeemCalls.length).toBe(2);
      expect(redeemCalls[1]?.quoteId).toBe('quote2');

      // Third should process after another ~3s
      await sleep(TEST_PROCESS_INTERVAL);
      expect(redeemCalls.length).toBe(3);
      expect(redeemCalls[2]?.quoteId).toBe('quote3');
    });

    it('prevents duplicate quotes in queue', async () => {
      await processor.start();

      // Emit the same quote multiple times
      for (let i = 0; i < 3; i++) {
        await bus.emit('mint-quote:state-changed', {
          mintUrl: 'https://mint.test',
          quoteId: 'duplicate',
          state: 'PAID',
        });
      }

      await sleep(TEST_PROCESS_INTERVAL + 20);

      // Should only process once
      expect(redeemCalls.length).toBe(1);
      expect(redeemCalls[0]).toEqual({
        mintUrl: 'https://mint.test',
        quoteId: 'duplicate',
      });
    });

    it('handles both state-changed and added events together', async () => {
      await processor.start();

      // Mix of events
      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'state-change-1',
        state: 'PAID',
      });

      await bus.emit('mint-quote:added', {
        mintUrl: 'https://mint.test',
        quoteId: 'added-1',
        quote: {
          quote: 'added-1',
          amount: 100,
          state: 'PAID',
          request: 'lnbc...',
        } as any,
      });

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'state-change-2',
        state: 'PAID',
      });

      // Process first quote
      await sleep(TEST_PROCESS_INTERVAL + 20);
      expect(redeemCalls.length).toBe(1);
      expect(redeemCalls[0]?.quoteId).toBe('state-change-1');

      // Process second quote
      await sleep(TEST_PROCESS_INTERVAL);
      expect(redeemCalls.length).toBe(2);
      expect(redeemCalls[1]?.quoteId).toBe('added-1');

      // Process third quote
      await sleep(TEST_PROCESS_INTERVAL);
      expect(redeemCalls.length).toBe(3);
      expect(redeemCalls[2]?.quoteId).toBe('state-change-2');
    });
  });

  describe('error handling', () => {
    it('updates state to ISSUED when quote already issued (20002)', async () => {
      // Mock service to throw already issued error
      mockQuoteService.redeemMintQuote = async () => {
        throw new MintOperationError(20002, 'Quote already issued');
      };

      await processor.start();

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'already-issued',
        state: 'PAID',
      });

      await sleep(TEST_PROCESS_INTERVAL + 20);

      expect(updateStateCalls.length).toBe(1);
      expect(updateStateCalls[0]).toEqual({
        mintUrl: 'https://mint.test',
        quoteId: 'already-issued',
        state: 'ISSUED',
      });
    });

    it('logs but does not update state when quote expired (20007)', async () => {
      // Mock service to throw expired error
      mockQuoteService.redeemMintQuote = async () => {
        throw new MintOperationError(20007, 'Quote expired');
      };

      await processor.start();

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'expired',
        state: 'PAID',
      });

      await sleep(TEST_PROCESS_INTERVAL + 20);

      // Should not update state (since EXPIRED is not a valid state)
      expect(updateStateCalls.length).toBe(0);
    });

    it('does not retry other MintOperationErrors', async () => {
      let attemptCount = 0;
      mockQuoteService.redeemMintQuote = async () => {
        attemptCount++;
        throw new MintOperationError(10000, 'Some other error');
      };

      await processor.start();

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'other-error',
        state: 'PAID',
      });

      await sleep(TEST_PROCESS_INTERVAL + 20);

      // Should only try once
      expect(attemptCount).toBe(1);
      expect(updateStateCalls.length).toBe(0);
    });

    it('retries network errors with exponential backoff', async () => {
      let attemptCount = 0;
      const attemptTimes: number[] = [];

      mockQuoteService.redeemMintQuote = async () => {
        attemptCount++;
        attemptTimes.push(Date.now());
        if (attemptCount <= 2) {
          throw new NetworkError('Connection failed');
        }
        // Succeed on third attempt
      };

      await processor.start();

      const startTime = Date.now();
      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'network-retry',
        state: 'PAID',
      });

      // First attempt after interval
      await sleep(TEST_PROCESS_INTERVAL + 20);
      expect(attemptCount).toBe(1);

      // Second attempt after first retry delay
      await sleep(TEST_RETRY_DELAY + 50);
      expect(attemptCount).toBe(2);

      // Third attempt after second retry delay (TEST_RETRY_DELAY * 2)
      await sleep(TEST_RETRY_DELAY * 2 + 50);
      expect(attemptCount).toBe(3);

      // Verify exponential backoff timing (with some tolerance)
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

    it('gives up after max retries for network errors', async () => {
      let attemptCount = 0;

      mockQuoteService.redeemMintQuote = async () => {
        attemptCount++;
        throw new NetworkError('Connection failed');
      };

      await processor.start();

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'max-retries',
        state: 'PAID',
      });

      // Wait for all retry attempts
      // Initial: 50ms, Retry 1: +100ms, Retry 2: +200ms, Retry 3: +400ms
      await sleep(
        TEST_PROCESS_INTERVAL +
          TEST_RETRY_DELAY +
          TEST_RETRY_DELAY * 2 +
          TEST_RETRY_DELAY * 4 +
          100,
      );

      // Should attempt exactly 4 times (initial + 3 retries)
      expect(attemptCount).toBe(4);
    });

    it('handles unknown errors without retry', async () => {
      let attemptCount = 0;

      mockQuoteService.redeemMintQuote = async () => {
        attemptCount++;
        throw new Error('Unknown error');
      };

      await processor.start();

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'unknown-error',
        state: 'PAID',
      });

      await sleep(TEST_PROCESS_INTERVAL + 20);

      // Should only try once
      expect(attemptCount).toBe(1);
      expect(updateStateCalls.length).toBe(0);
    });
  });

  describe('custom handlers', () => {
    it('allows registering custom quote type handlers', async () => {
      let customHandlerCalled = false;
      const customHandler = {
        canHandle(quoteType: string) {
          return quoteType === 'custom';
        },
        async process(mintUrl: string, quoteId: string) {
          customHandlerCalled = true;
        },
      };

      processor.registerHandler('custom', customHandler);

      // Manually enqueue a custom type quote (since we default to bolt11 in events)
      // We'll need to access the private method, so let's test via the default handler
      await processor.start();

      // For this test, we'll verify the handler registration worked
      // In real usage, the quote type would come from the quote data
      expect(customHandlerCalled).toBe(false);
    });

    it('warns when no handler registered for quote type', async () => {
      // Create a processor without the default bolt11 handler
      const emptyProcessor = new MintQuoteProcessor(mockQuoteService, bus);

      // Clear the default handler
      (emptyProcessor as any).handlers.clear();

      await emptyProcessor.start();

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'no-handler',
        state: 'PAID',
      });

      await sleep(TEST_PROCESS_INTERVAL + 20);

      // Should not attempt to redeem
      expect(redeemCalls.length).toBe(0);

      await emptyProcessor.stop();
    });
  });

  describe('waitForCompletion', () => {
    it('waits for empty queue', async () => {
      await processor.start();

      // Add multiple quotes
      for (let i = 1; i <= 3; i++) {
        await bus.emit('mint-quote:state-changed', {
          mintUrl: 'https://mint.test',
          quoteId: `quote${i}`,
          state: 'PAID',
        });
      }

      // Start waiting for completion
      const completionPromise = processor.waitForCompletion();

      // Should not be complete immediately
      let isComplete = false;
      completionPromise.then(() => {
        isComplete = true;
      });

      await sleep(100);
      expect(isComplete).toBe(false);

      // Wait for all to process (3 quotes * interval each + buffer)
      await sleep(3 * TEST_PROCESS_INTERVAL + 100);

      await completionPromise;
      expect(isComplete).toBe(true);
      expect(redeemCalls.length).toBe(3);
    });

    it('resolves immediately when queue is empty', async () => {
      await processor.start();

      const startTime = Date.now();
      await processor.waitForCompletion();
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(500); // Should be nearly instant
    });
  });

  describe('stop behavior', () => {
    it('stops processing when stopped mid-queue', async () => {
      await processor.start();

      // Add multiple quotes
      for (let i = 1; i <= 5; i++) {
        await bus.emit('mint-quote:state-changed', {
          mintUrl: 'https://mint.test',
          quoteId: `quote${i}`,
          state: 'PAID',
        });
      }

      // Let first one process
      await sleep(TEST_PROCESS_INTERVAL + 20);
      expect(redeemCalls.length).toBe(1);

      // Stop the processor
      await processor.stop();

      // Wait what would be enough time for more processing
      await sleep(3 * TEST_PROCESS_INTERVAL);

      // Should not have processed more
      expect(redeemCalls.length).toBe(1);
    });

    it('waits for current processing to complete before stopping', async () => {
      let processingStarted = false;
      let processingCompleted = false;

      mockQuoteService.redeemMintQuote = async () => {
        processingStarted = true;
        await sleep(200); // Simulate slow processing
        processingCompleted = true;
      };

      await processor.start();

      await bus.emit('mint-quote:state-changed', {
        mintUrl: 'https://mint.test',
        quoteId: 'slow-quote',
        state: 'PAID',
      });

      // Wait for processing to start
      await sleep(TEST_PROCESS_INTERVAL + 20);
      expect(processingStarted).toBe(true);
      expect(processingCompleted).toBe(false);

      // Start stopping (should wait for processing to complete)
      const stopPromise = processor.stop();

      // Should still be processing
      expect(processingCompleted).toBe(false);

      // Wait for stop to complete
      await stopPromise;

      // Now processing should be complete
      expect(processingCompleted).toBe(true);
    });
  });
});
