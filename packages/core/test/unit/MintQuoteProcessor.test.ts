import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, afterEach, expect, mock } from 'bun:test';
import { MintOperationProcessor } from '../../services/watchers/MintOperationProcessor';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MintOperationService } from '../../operations/mint/MintOperationService';
import { MintOperationError, NetworkError } from '../../models/Error';
import { mintQuoteFromBolt11Response } from '../../models/MintQuote.ts';
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
      async hasLocallyClaimableMintQuoteBalance() {
        return true;
      },
      async claimPendingMintQuotes() {
        startupClaimCalls++;
        return [];
      },
    } as unknown as MintOperationService;

    mockQuoteLifecycle = {
      async getMintQuote() {
        return {
          mintUrl: 'https://mint.test',
          method: 'bolt11',
          quoteId: 'quote-2',
          quote: 'quote-2',
          request: 'lnbc1test',
          amount: 10,
          unit: 'sat',
          expiry: null,
          state: 'PAID',
          reusable: false,
          quoteData: { amount: 10 },
        } as any;
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

  it('offers all ready BOLT11 operations to one processor coordination turn', async () => {
    const scheduled: string[] = [];
    const states = new Map([
      ['mint-op-1', 'pending'],
      ['mint-op-2', 'pending'],
    ]);
    let markCoordinationStarted!: () => void;
    const coordinationStarted = new Promise<void>((resolve) => {
      markCoordinationStarted = resolve;
    });
    const coordinateScheduledIssuance = mock(async () => {
      markCoordinationStarted();
      for (const operationId of scheduled) states.set(operationId, 'finalized');
    });
    mockMintOperationService = {
      async getOperationsForQuote(_mintUrl: string, _method: string, quoteId: string) {
        const id = quoteId.replace('quote', 'mint-op');
        return [
          {
            id,
            state: states.get(id),
            mintUrl: 'https://mint.test',
            method: 'bolt11',
          },
        ];
      },
      scheduleIssuance(operationId: string) {
        scheduled.push(operationId);
      },
      coordinateScheduledIssuance,
      async getOperation(operationId: string) {
        return {
          id: operationId,
          state: states.get(operationId),
          mintUrl: 'https://mint.test',
          method: 'bolt11',
        };
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
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      },
    );
    await processor.start();

    for (const quoteId of ['quote-1', 'quote-2']) {
      await bus.emit('mint-quote:updated', {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId,
        quote: mintQuoteFromBolt11Response('https://mint.test', {
          quote: quoteId,
          request: `lnbc1${quoteId}`,
          amount: Amount.from(10),
          unit: 'sat',
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'PAID',
        }),
      });
    }
    await coordinationStarted;
    await processor.waitForCompletion();

    expect(scheduled).toEqual(['mint-op-1', 'mint-op-2']);
    expect(coordinateScheduledIssuance).toHaveBeenCalledTimes(1);
    expect(finalizeCalls).toEqual([]);
  });

  it('retries safe pending and attached issuance after a transient coordinator failure', async () => {
    for (const stateAfterFailure of ['pending', 'executing'] as const) {
      let state: 'pending' | 'executing' | 'finalized' = 'pending';
      const operation = () => ({
        id: `mint-op-retry-${stateAfterFailure}`,
        state,
        mintUrl: 'https://mint.test',
        method: 'bolt11' as const,
        quoteId: `quote-retry-${stateAfterFailure}`,
        amount: Amount.from(10),
        unit: 'sat' as const,
      });
      const coordinateScheduledIssuance = mock(async () => {
        state = 'finalized';
      });
      coordinateScheduledIssuance.mockImplementationOnce(async () => {
        state = stateAfterFailure;
        throw new NetworkError('transient issuance failure');
      });
      mockMintOperationService = {
        scheduleIssuance() {},
        coordinateScheduledIssuance,
        async getOperation() {
          return operation();
        },
        async canRetryIssuance() {
          return true;
        },
        isIssuanceScheduled() {
          return true;
        },
        wasIssuanceSelectedInLastTurn() {
          return true;
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
          processIntervalMs: 1,
          baseRetryDelayMs: 1,
          initialEnqueueDelayMs: 0,
        },
      );
      await processor.start();
      await bus.emit('mint-op:requeue', {
        mintUrl: operation().mintUrl,
        operationId: operation().id,
        operation: operation() as CoreEvents['mint-op:requeue']['operation'],
      });

      await processor.waitForCompletion();

      expect(operation().state).toBe('finalized');
      expect(coordinateScheduledIssuance).toHaveBeenCalledTimes(2);
      await processor.stop();
    }
  });

  it('drains a pending BOLT11 item that the coordinator declines as ineligible', async () => {
    let markRepeated!: () => void;
    const repeated = new Promise<void>((resolve) => {
      markRepeated = resolve;
    });
    const operation = {
      id: 'mint-op-ineligible',
      state: 'pending' as const,
      mintUrl: 'https://mint.test',
      method: 'bolt11' as const,
      quoteId: 'quote-ineligible',
      amount: Amount.from(10),
      unit: 'sat' as const,
    };
    const coordinateScheduledIssuance = mock(async () => {
      markRepeated();
    });
    coordinateScheduledIssuance.mockImplementationOnce(async () => {});
    mockMintOperationService = {
      scheduleIssuance() {},
      coordinateScheduledIssuance,
      async getOperation() {
        return operation;
      },
      isIssuanceScheduled() {
        return false;
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
        processIntervalMs: 1,
        initialEnqueueDelayMs: 0,
      },
    );
    await processor.start();
    await bus.emit('mint-op:requeue', {
      mintUrl: operation.mintUrl,
      operationId: operation.id,
      operation: operation as CoreEvents['mint-op:requeue']['operation'],
    });

    const drainedBeforeRepeat = await Promise.race([
      processor.waitForCompletion().then(() => true),
      repeated.then(() => false),
    ]);

    expect(drainedBeforeRepeat).toBe(true);
    expect(coordinateScheduledIssuance).toHaveBeenCalledTimes(1);
  });

  it('keeps eligible unselected work after another cohort fails', async () => {
    const states = new Map<string, 'pending' | 'executing' | 'finalized'>([
      ['mint-op-selected', 'pending'],
      ['mint-op-unselected', 'pending'],
    ]);
    const coordinateScheduledIssuance = mock(async () => {
      states.set('mint-op-unselected', 'finalized');
    });
    coordinateScheduledIssuance.mockImplementationOnce(async () => {
      states.set('mint-op-selected', 'executing');
      throw new Error('selected cohort failed validation');
    });
    mockMintOperationService = {
      scheduleIssuance() {},
      coordinateScheduledIssuance,
      async getOperation(operationId: string) {
        return {
          id: operationId,
          state: states.get(operationId),
          mintUrl: 'https://mint.test',
          method: 'bolt11',
        };
      },
      async canRetryIssuance() {
        return false;
      },
      isIssuanceScheduled(operationId: string) {
        return operationId === 'mint-op-unselected';
      },
      wasIssuanceSelectedInLastTurn(operationId: string) {
        return operationId === 'mint-op-selected';
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
        processIntervalMs: 1,
        initialEnqueueDelayMs: 0,
      },
    );
    await processor.start();
    for (const operationId of states.keys()) {
      await bus.emit('mint-op:requeue', {
        mintUrl: 'https://mint.test',
        operationId,
        operation: {
          id: operationId,
          mintUrl: 'https://mint.test',
          method: 'bolt11',
        } as CoreEvents['mint-op:requeue']['operation'],
      });
    }

    await processor.waitForCompletion();

    expect(states.get('mint-op-unselected')).toBe('finalized');
    expect(coordinateScheduledIssuance).toHaveBeenCalledTimes(2);
  });

  it('rotates ready non-BOLT11 work ahead of the next BOLT11 cohort', async () => {
    const turns: string[] = [];
    let markNonBolt11Processed!: () => void;
    const nonBolt11Processed = new Promise<void>((resolve) => {
      markNonBolt11Processed = resolve;
    });
    mockMintOperationService = {
      scheduleIssuance() {},
      async coordinateScheduledIssuance() {
        turns.push('bolt11');
      },
      async getOperation(operationId: string) {
        return {
          id: operationId,
          state: 'pending',
          mintUrl: 'https://mint.test',
          method: 'bolt11',
        };
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
        initialEnqueueDelayMs: TEST_INITIAL_DELAY,
      },
    );
    processor.registerHandler('bolt12', {
      async process() {
        turns.push('bolt12');
        markNonBolt11Processed();
      },
    });
    await processor.start();

    for (const [operationId, method] of [
      ['mint-op-bolt11-a', 'bolt11'],
      ['mint-op-bolt11-b', 'bolt11'],
      ['mint-op-bolt12', 'bolt12'],
    ] as const) {
      await bus.emit('mint-op:requeue', {
        mintUrl: 'https://mint.test',
        operationId,
        operation: {
          id: operationId,
          mintUrl: 'https://mint.test',
          method,
        } as CoreEvents['mint-op:requeue']['operation'],
      });
    }

    await nonBolt11Processed;

    expect(turns.slice(0, 2)).toEqual(['bolt11', 'bolt12']);
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

  it('resumes an executing migrated operation when its quote becomes paid', async () => {
    mockMintOperationService = {
      async getOperationsForQuote() {
        return [
          {
            id: 'migrated-mint-op',
            state: 'executing',
            mintUrl: 'https://mint.test',
            method: 'bolt11',
          },
        ];
      },
      async finalize(operationId: string) {
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

    await bus.emit('mint-quote:updated', {
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      quoteId: 'migrated-quote',
      quote: {
        mintUrl: 'https://mint.test',
        method: 'bolt11',
        quoteId: 'migrated-quote',
        quote: 'migrated-quote',
        state: 'PAID',
      } as any,
    });

    await sleep(TEST_PROCESS_INTERVAL * 2 + 50);

    expect(finalizeCalls).toEqual(['migrated-mint-op']);
  });

  it('claims reusable onchain quotes with locally claimable balance from mint-quote:updated', async () => {
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

  it('skips reusable onchain quote claims with no locally claimable balance', async () => {
    mockMintOperationService = {
      ...mockMintOperationService,
      async hasLocallyClaimableMintQuoteBalance() {
        return false;
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

    expect(claimCalls).toEqual([]);
  });

  it('logs and skips reusable onchain quote claims when claimability check fails', async () => {
    mockMintOperationService = {
      ...mockMintOperationService,
      async hasLocallyClaimableMintQuoteBalance() {
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

  it('claims pending reusable mint quotes on startup', async () => {
    await processor.start();
    await processor.waitForCompletion();

    expect(startupClaimCalls).toBe(1);
  });

  it('can disable reusable mint quote auto-claiming', async () => {
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
        quoteId: 'quote-2',
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
