import {
  Amount,
  type MintQuoteBolt11Response,
  type MintQuoteOnchainResponse,
} from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import {
  MintOperationWatcherService,
  type MintOperationWatcherOptions,
} from '../../services/watchers/MintOperationWatcherService.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { MintService } from '../../services/MintService.ts';
import type { MintOperationService } from '../../operations/mint/MintOperationService.ts';
import type {
  FailedMintOperation,
  PendingMintOperation,
} from '../../operations/mint/MintOperation.ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import { NullLogger } from '../../logging/NullLogger.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';

describe('MintOperationWatcherService', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-1';

  let bus: EventBus<CoreEvents>;
  let subscribe: Mock<any>;
  let unsubscribe: Mock<any>;
  let callback:
    | ((payload: MintQuoteBolt11Response | MintQuoteOnchainResponse | any) => Promise<void>)
    | undefined;

  const makePendingOperation = (): PendingMintOperation => ({
    id: 'mint-op-1',
    state: 'pending',
    mintUrl,
    method: 'bolt11',
    methodData: {},
    amount: Amount.from(10),
    unit: 'sat',
    quoteId,
    request: 'lnbc1test',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const makeFailedOperation = (operation = makePendingOperation()): FailedMintOperation => ({
    ...operation,
    state: 'failed',
    updatedAt: Date.now(),
    error: 'Quote expired before issuance',
    terminalFailure: {
      reason: 'Quote expired before issuance',
      code: 'quote_expired',
      retryable: false,
      observedAt: Date.now(),
    },
  });

  const makeOnchainOperation = (): PendingMintOperation<'onchain'> =>
    ({
      id: 'mint-op-onchain-1',
      state: 'pending',
      mintUrl,
      method: 'onchain',
      methodData: {},
      amount: Amount.from(10),
      unit: 'sat',
      quoteId,
      request: 'bc1ptest',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }) as PendingMintOperation<'onchain'>;

  const makeBolt11Quote = (): MintQuote<'bolt11'> => ({
    mintUrl,
    method: 'bolt11',
    quoteId,
    quote: quoteId,
    request: 'lnbc1test',
    amount: Amount.from(10),
    unit: 'sat',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    state: 'UNPAID',
    reusable: false,
    quoteData: {
      amount: Amount.from(10),
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const makeOnchainQuote = (): MintQuote<'onchain'> => ({
    mintUrl,
    method: 'onchain',
    quoteId,
    quote: quoteId,
    request: 'bc1ptest',
    unit: 'sat',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    reusable: true,
    quoteData: {
      pubkey: 'pubkey-1',
      amountPaid: Amount.zero(),
      amountIssued: Amount.zero(),
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const makeBolt12Quote = (expiry: number | null = 0): MintQuote<'bolt12'> => ({
    mintUrl,
    method: 'bolt12',
    quoteId,
    quote: quoteId,
    request: 'lno1offer',
    unit: 'sat',
    expiry,
    reusable: true,
    quoteData: {
      pubkey: 'pubkey-1',
      amountPaid: Amount.zero(),
      amountIssued: Amount.zero(),
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const makeQuoteLifecycle = (
    overrides: Partial<
      Pick<QuoteLifecycle, 'getPendingMintQuotes' | 'recordMintQuoteSnapshot'>
    > = {},
  ): QuoteLifecycle =>
    ({
      getPendingMintQuotes: mock(async () => []),
      recordMintQuoteSnapshot: mock(async () => makeBolt11Quote()),
      ...overrides,
    }) as unknown as QuoteLifecycle;

  const makeWatcher = ({
    mintService = { isTrustedMint: mock(async () => true) } as unknown as MintService,
    mintOperations = {} as unknown as MintOperationService,
    quoteLifecycle = makeQuoteLifecycle(),
    options,
  }: {
    mintService?: MintService;
    mintOperations?: MintOperationService;
    quoteLifecycle?: QuoteLifecycle;
    options?: MintOperationWatcherOptions;
  } = {}): MintOperationWatcherService =>
    new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      mintService,
      mintOperations,
      quoteLifecycle,
      bus,
      new NullLogger(),
      options,
    );

  beforeEach(() => {
    bus = new EventBus<CoreEvents>();
    unsubscribe = mock(async () => {});
    callback = undefined;
    subscribe = mock(
      async (
        _mintUrl: string,
        _kind: string,
        _filters: string[],
        next: (payload: MintQuoteBolt11Response | MintQuoteOnchainResponse | any) => Promise<void>,
      ) => {
        callback = next;
        return { subId: 'sub-1', unsubscribe };
      },
    );
  });

  it('watches existing pending canonical mint quotes on startup', async () => {
    const quote = makeBolt11Quote();
    const onchainQuote = makeOnchainQuote();
    const getPendingMintQuotes = mock(async () => [quote, onchainQuote]);
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getPendingMintQuotes,
      }),
      options: { watchExistingPendingOnStart: false },
    });

    await watcher.start();

    expect(getPendingMintQuotes).toHaveBeenCalledWith();
    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt11_mint_quote',
      [quoteId],
      expect.any(Function),
    );
    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'onchain_mint_quote',
      [quoteId],
      expect.any(Function),
    );

    await watcher.stop();
  });

  it('stops a terminal quote without removing an active sibling watch', async () => {
    const quote1 = makeBolt11Quote();
    const quote2 = {
      ...makeBolt11Quote(),
      quoteId: 'quote-2',
      quote: 'quote-2',
      request: 'lnbc1peer',
    };
    const callbacks = new Map<string, (payload: MintQuoteBolt11Response) => Promise<void>>();
    const unsubscribes = new Map<string, Mock<any>>();
    subscribe.mockImplementation(
      async (
        _mintUrl: string,
        _kind: string,
        filters: string[],
        next: (payload: MintQuoteBolt11Response) => Promise<void>,
      ) => {
        const watchedQuoteId = filters[0]!;
        const stop = mock(async () => {});
        callbacks.set(watchedQuoteId, next);
        unsubscribes.set(watchedQuoteId, stop);
        return { subId: `sub-${watchedQuoteId}`, unsubscribe: stop };
      },
    );
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getPendingMintQuotes: mock(async () => [quote1, quote2]),
      }),
      options: { watchExistingPendingOnStart: false },
    });

    await watcher.start();
    await callbacks.get(quote1.quoteId)?.({
      quote: quote1.quoteId,
      request: quote1.request,
      amount: quote1.amount,
      unit: quote1.unit,
      expiry: quote1.expiry,
      state: 'ISSUED',
    });

    expect(unsubscribes.get(quote1.quoteId)).toHaveBeenCalledTimes(1);
    expect(unsubscribes.get(quote2.quoteId)).not.toHaveBeenCalled();

    await watcher.stop();
    expect(unsubscribes.get(quote2.quoteId)).toHaveBeenCalledTimes(1);
  });

  it('watches pending canonical onchain mint quotes', async () => {
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getPendingMintQuotes: mock(async () => [makeOnchainQuote()]),
      }),
      options: { watchExistingPendingOnStart: false },
    });

    await watcher.start();

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'onchain_mint_quote',
      [quoteId],
      expect.any(Function),
    );

    await watcher.stop();
  });

  it('watches a pending canonical BOLT12 quote with no-expiry sentinel on startup', async () => {
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getPendingMintQuotes: mock(async () => [makeBolt12Quote()]),
      }),
      options: { watchExistingPendingOnStart: false },
    });

    await watcher.start();

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt12_mint_quote',
      [quoteId],
      expect.any(Function),
    );

    await watcher.stop();
  });

  it('keeps null-expiry BOLT12 quote behavior unchanged on startup', async () => {
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getPendingMintQuotes: mock(async () => [makeBolt12Quote(null)]),
      }),
      options: { watchExistingPendingOnStart: false },
    });

    await watcher.start();

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt12_mint_quote',
      [quoteId],
      expect.any(Function),
    );

    await watcher.stop();
  });

  it('watches a pending canonical onchain quote with no-expiry sentinel on startup', async () => {
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getPendingMintQuotes: mock(async () => [{ ...makeOnchainQuote(), expiry: 0 }]),
      }),
      options: { watchExistingPendingOnStart: false },
    });

    await watcher.start();

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'onchain_mint_quote',
      [quoteId],
      expect.any(Function),
    );

    await watcher.stop();
  });

  it('does not start watching already expired canonical mint quotes', async () => {
    const expiredQuote = {
      ...makeBolt11Quote(),
      expiry: Math.floor(Date.now() / 1000) - 1,
    };
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getPendingMintQuotes: mock(async () => [expiredQuote]),
      }),
      options: { watchExistingPendingOnStart: false },
    });

    await watcher.start();

    expect(subscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('watches pending onchain mint operations', async () => {
    const watcher = makeWatcher({
      mintOperations: {
        getPendingOperations: mock(async () => [makeOnchainOperation()]),
      } as unknown as MintOperationService,
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'onchain_mint_quote',
      [quoteId],
      expect.any(Function),
    );

    await watcher.stop();
  });

  it('watches canonical mint quotes created after startup', async () => {
    const quote = makeBolt11Quote();
    const watcher = makeWatcher({
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('mint-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote,
    });

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt11_mint_quote',
      [quoteId],
      expect.any(Function),
    );

    await watcher.stop();
  });

  it('records PAID subscription updates without re-checking the quote remotely', async () => {
    const operation = makePendingOperation();
    const observePendingOperation = mock(async () => {
      throw new Error('should not re-check');
    });
    const recordMintQuoteSnapshot = mock(
      async (_mintUrl: string, _method: string, quote: MintQuoteBolt11Response) => ({
        mintUrl,
        method: 'bolt11' as const,
        quoteId: quote.quote,
        quote: quote.quote,
        request: quote.request,
        amount: quote.amount,
        unit: quote.unit,
        expiry: quote.expiry,
        state: quote.state,
        reusable: false as const,
        quoteData: {
          amount: quote.amount,
        },
        createdAt: operation.createdAt,
        updatedAt: Date.now(),
      }),
    );
    const getOperation = mock(async () => {
      throw new Error('should not need an operation');
    });

    const watcher = makeWatcher({
      mintOperations: {
        observePendingOperation,
        getOperation,
      } as unknown as MintOperationService,
      quoteLifecycle: makeQuoteLifecycle({
        recordMintQuoteSnapshot,
      }),
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    if (!callback) {
      throw new Error('Expected watcher subscription callback');
    }

    await callback({
      quote: quoteId,
      request: operation.request,
      amount: operation.amount,
      unit: operation.unit,
      expiry: operation.expiry,
      state: 'PAID',
    });

    expect(getOperation).not.toHaveBeenCalled();
    expect(observePendingOperation).not.toHaveBeenCalled();
    expect(recordMintQuoteSnapshot).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      expect.objectContaining({ quote: quoteId, state: 'PAID' }),
    );
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('stops watching expired subscription updates without recording unimportant states', async () => {
    const operation = makePendingOperation();
    const recordMintQuoteSnapshot = mock(async () => makeBolt11Quote());

    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        recordMintQuoteSnapshot,
      }),
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });

    if (!callback) {
      throw new Error('Expected watcher subscription callback');
    }

    await callback({
      quote: quoteId,
      request: operation.request,
      amount: operation.amount,
      unit: operation.unit,
      expiry: Math.floor(Date.now() / 1000) - 1,
      state: 'UNPAID',
    });

    expect(recordMintQuoteSnapshot).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('records ISSUED subscription updates and stops watching the operation', async () => {
    const operation = makePendingOperation();
    const recordMintQuoteSnapshot = mock(
      async (_mintUrl: string, _method: string, quote: MintQuoteBolt11Response) => ({
        mintUrl,
        method: 'bolt11' as const,
        quoteId: quote.quote,
        quote: quote.quote,
        request: quote.request,
        amount: quote.amount,
        unit: quote.unit,
        expiry: quote.expiry,
        state: quote.state,
        reusable: false as const,
        quoteData: {
          amount: quote.amount,
        },
        createdAt: operation.createdAt,
        updatedAt: Date.now(),
      }),
    );

    const watcher = makeWatcher({
      mintOperations: {
        getOperation: mock(async () => operation),
      } as unknown as MintOperationService,
      quoteLifecycle: makeQuoteLifecycle({
        recordMintQuoteSnapshot,
      }),
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });

    if (!callback) {
      throw new Error('Expected watcher subscription callback');
    }

    await callback({
      quote: quoteId,
      request: operation.request,
      amount: operation.amount,
      unit: operation.unit,
      expiry: operation.expiry,
      state: 'ISSUED',
    });

    expect(recordMintQuoteSnapshot).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      expect.objectContaining({ quote: quoteId, state: 'ISSUED' }),
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('creates one subscription for canonical and operation interest in the same quote', async () => {
    const quote = makeBolt11Quote();
    const operation = makePendingOperation();

    const watcher = makeWatcher({
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });
    await bus.emit('mint-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote,
    });

    expect(subscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('records complete onchain subscription payloads', async () => {
    const operation = makeOnchainOperation();
    const recordMintQuoteSnapshot = mock(async () => makeOnchainQuote());

    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        recordMintQuoteSnapshot,
      }),
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });

    if (!callback) {
      throw new Error('Expected watcher subscription callback');
    }

    await callback({
      quote: quoteId,
      request: operation.request,
      unit: operation.unit,
      expiry: operation.expiry,
      pubkey: 'pubkey-1',
      amount_paid: Amount.from(10),
      amount_issued: Amount.zero(),
    });

    expect(recordMintQuoteSnapshot).toHaveBeenCalledWith(
      mintUrl,
      'onchain',
      expect.objectContaining({
        quote: quoteId,
        amount_paid: Amount.from(10),
        amount_issued: Amount.zero(),
      }),
    );
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('keeps watching after a BOLT12 update with no-expiry sentinel', async () => {
    const quote = makeBolt12Quote();
    const recordMintQuoteSnapshot = mock(async () => quote);
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getPendingMintQuotes: mock(async () => [quote]),
        recordMintQuoteSnapshot,
      }),
      options: { watchExistingPendingOnStart: false },
    });

    await watcher.start();
    if (!callback) {
      throw new Error('Expected watcher subscription callback');
    }

    await callback({
      quote: quoteId,
      request: quote.request,
      unit: quote.unit,
      expiry: 0,
      pubkey: quote.quoteData.pubkey,
      amount_paid: Amount.from(10),
      amount_issued: Amount.zero(),
    });

    expect(recordMintQuoteSnapshot).toHaveBeenCalledWith(
      mintUrl,
      'bolt12',
      expect.objectContaining({ quote: quoteId, expiry: 0 }),
    );
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('drops incomplete onchain payloads without stopping the watch', async () => {
    const operation = makeOnchainOperation();
    const recordMintQuoteSnapshot = mock(async () => makeOnchainQuote());

    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        recordMintQuoteSnapshot,
      }),
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });

    if (!callback) {
      throw new Error('Expected watcher subscription callback');
    }

    await callback({
      quote: quoteId,
      request: operation.request,
      unit: operation.unit,
      expiry: operation.expiry,
      amount_paid: Amount.from(10),
    });

    expect(recordMintQuoteSnapshot).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('stops onchain quote watching when an incomplete payload is expired', async () => {
    const operation = makeOnchainOperation();
    const recordMintQuoteSnapshot = mock(async () => makeOnchainQuote());

    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        recordMintQuoteSnapshot,
      }),
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });

    if (!callback) {
      throw new Error('Expected watcher subscription callback');
    }

    await callback({
      quote: quoteId,
      request: operation.request,
      unit: operation.unit,
      expiry: Math.floor(Date.now() / 1000) - 1,
    });

    expect(recordMintQuoteSnapshot).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('does not stop onchain quote watching when amount_paid equals amount_issued', async () => {
    const operation = makeOnchainOperation();
    const recordMintQuoteSnapshot = mock(async () => makeOnchainQuote());

    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        recordMintQuoteSnapshot,
      }),
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });

    if (!callback) {
      throw new Error('Expected watcher subscription callback');
    }

    await callback({
      quote: quoteId,
      request: operation.request,
      unit: operation.unit,
      expiry: operation.expiry,
      pubkey: 'pubkey-1',
      amount_paid: Amount.from(10),
      amount_issued: Amount.from(10),
    });

    expect(recordMintQuoteSnapshot).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('keeps reusable onchain quote watches after operation finalization', async () => {
    const operation = makeOnchainOperation();

    const watcher = makeWatcher({
      mintOperations: {
        getPendingOperations: mock(async () => [operation]),
      } as unknown as MintOperationService,
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    expect(subscribe).toHaveBeenCalledTimes(1);

    await bus.emit('mint-op:finalized', {
      mintUrl,
      operationId: operation.id,
      operation: { ...operation, state: 'finalized' },
    });

    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not unsubscribe while canonical interest remains after an operation finalizes', async () => {
    const quote = makeBolt11Quote();
    const operation = makePendingOperation();

    const watcher = makeWatcher({
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('mint-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote,
    });
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });

    await bus.emit('mint-op:finalized', {
      mintUrl,
      operationId: operation.id,
      operation: { ...operation, state: 'finalized' },
    });

    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps watching when one of multiple operation interests finalizes', async () => {
    const first = makePendingOperation();
    const second = { ...makePendingOperation(), id: 'mint-op-2' };

    const watcher = makeWatcher({
      mintOperations: {
        getPendingOperations: mock(async () => [first, second]),
      } as unknown as MintOperationService,
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();

    expect(subscribe).toHaveBeenCalledTimes(1);

    await bus.emit('mint-op:finalized', {
      mintUrl,
      operationId: first.id,
      operation: { ...first, state: 'finalized' },
    });
    expect(unsubscribe).not.toHaveBeenCalled();

    await bus.emit('mint-op:finalized', {
      mintUrl,
      operationId: second.id,
      operation: { ...second, state: 'finalized' },
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('stops operation-specific watch interest when an operation fails', async () => {
    const operation = makePendingOperation();

    const watcher = makeWatcher({
      mintOperations: {
        getPendingOperations: mock(async () => [operation]),
      } as unknown as MintOperationService,
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    expect(subscribe).toHaveBeenCalledTimes(1);

    await bus.emit('mint-op:failed', {
      mintUrl,
      operationId: operation.id,
      operation: makeFailedOperation(operation),
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
