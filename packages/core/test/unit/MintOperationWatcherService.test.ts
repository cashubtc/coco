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
  FinalizedMintOperation,
  MintOperation,
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
    outputData: '{"keep":[],"send":[]}' as unknown as PendingMintOperation['outputData'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const makeFailedOperation = (operation = makePendingOperation()): FailedMintOperation => ({
    ...operation,
    state: 'failed',
    updatedAt: Date.now(),
    error: 'Quote response failed validation',
    terminalFailure: {
      reason: 'Quote response failed validation',
      code: 'invalid_quote',
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
      outputData: '{"keep":[],"send":[]}' as unknown as PendingMintOperation['outputData'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }) as PendingMintOperation<'onchain'>;

  const makeBolt12Operation = (): PendingMintOperation<'bolt12'> =>
    ({
      id: 'mint-op-bolt12-1',
      state: 'pending',
      mintUrl,
      method: 'bolt12',
      methodData: {},
      amount: Amount.from(10),
      unit: 'sat',
      quoteId,
      request: 'lno1offer',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      outputData: '{"keep":[],"send":[]}' as unknown as PendingMintOperation['outputData'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }) as PendingMintOperation<'bolt12'>;

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
    amountPaid: Amount.zero(),
    amountIssued: Amount.zero(),
    remoteUpdatedAt: null,
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
    amountPaid: Amount.zero(),
    amountIssued: Amount.zero(),
    remoteUpdatedAt: null,
    quoteData: {
      pubkey: 'pubkey-1',
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
    amountPaid: Amount.zero(),
    amountIssued: Amount.zero(),
    remoteUpdatedAt: null,
    quoteData: {
      pubkey: 'pubkey-1',
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

  it('watches expired canonical mint quotes on startup', async () => {
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

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt11_mint_quote',
      [quoteId],
      expect.any(Function),
    );

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

  it('watches canonical quotes from accounting when compatibility state disagrees', async () => {
    const quote = { ...makeBolt11Quote(), state: 'ISSUED' as const };
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

  it('records paid accounting even when the compatibility state contradicts it', async () => {
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
        amountPaid: Amount.from(quote.amount_paid),
        amountIssued: Amount.from(quote.amount_issued),
        remoteUpdatedAt: quote.updated_at,
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
      state: 'UNPAID',
      amount_paid: operation.amount,
      amount_issued: Amount.zero(),
      updated_at: 20,
    });

    expect(getOperation).not.toHaveBeenCalled();
    expect(observePendingOperation).not.toHaveBeenCalled();
    expect(recordMintQuoteSnapshot).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      expect.objectContaining({
        quote: quoteId,
        state: 'UNPAID',
        amount_paid: operation.amount,
        amount_issued: Amount.zero(),
      }),
    );
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('records expired unpaid subscription updates and keeps watching', async () => {
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

    expect(recordMintQuoteSnapshot).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      expect.objectContaining({ quote: quoteId, state: 'UNPAID' }),
    );
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('stops on issued accounting even when the compatibility state contradicts it', async () => {
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
        amountPaid: Amount.from(quote.amount_paid),
        amountIssued: Amount.from(quote.amount_issued),
        remoteUpdatedAt: quote.updated_at,
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
      state: 'PAID',
      amount_paid: operation.amount,
      amount_issued: operation.amount,
      updated_at: 21,
    });

    expect(recordMintQuoteSnapshot).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      expect.objectContaining({
        quote: quoteId,
        state: 'PAID',
        amount_paid: operation.amount,
        amount_issued: operation.amount,
      }),
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('keeps watching after invalid issuance accounting', async () => {
    const operation = makePendingOperation();
    const recordMintQuoteSnapshot = mock(async () => {
      throw new Error('Invalid Mint Quote Accounting');
    });
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
      expiry: operation.expiry,
      state: 'ISSUED',
      amount_paid: Amount.from(9),
      amount_issued: operation.amount,
      updated_at: 21,
    });

    expect(recordMintQuoteSnapshot).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

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

  it('records BOLT12 accounting and keeps watching after expiry', async () => {
    const quote = makeBolt12Quote(Math.floor(Date.now() / 1000) - 1);
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
      expiry: quote.expiry,
      pubkey: quote.quoteData.pubkey,
      amount_paid: Amount.from(10),
      amount_issued: Amount.zero(),
    });

    expect(recordMintQuoteSnapshot).toHaveBeenCalledWith(
      mintUrl,
      'bolt12',
      expect.objectContaining({ quote: quoteId, expiry: quote.expiry }),
    );
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('passes incomplete onchain payloads to canonical validation without stopping the watch', async () => {
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

    expect(recordMintQuoteSnapshot).toHaveBeenCalledWith(
      mintUrl,
      'onchain',
      expect.objectContaining({ quote: quoteId }),
    );
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('passes incomplete onchain payloads after expiry to canonical validation', async () => {
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

    expect(recordMintQuoteSnapshot).toHaveBeenCalledWith(
      mintUrl,
      'onchain',
      expect.objectContaining({ quote: quoteId }),
    );
    expect(unsubscribe).not.toHaveBeenCalled();

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

  it('keeps onchain balance quote watches after operation finalization', async () => {
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

  it('keeps canonical quote watching when all operation interests finalize', async () => {
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
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps canonical quote watching when an operation fails', async () => {
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

    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps quote watching when an operation starts executing', async () => {
    const operation = makePendingOperation();

    const watcher = makeWatcher({
      mintOperations: {
        getPendingOperations: mock(async () => [operation]),
      } as unknown as MintOperationService,
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    expect(subscribe).toHaveBeenCalledTimes(1);

    await bus.emit('mint-op:executing', {
      mintUrl,
      operationId: operation.id,
      operation: { ...operation, state: 'executing' } as unknown as MintOperation,
    });

    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('stops watching once the canonical quote completes', async () => {
    const operation = makePendingOperation();
    const completedQuote: MintQuote<'bolt11'> = {
      ...makeBolt11Quote(),
      state: 'ISSUED',
      amountPaid: Amount.from(10),
      amountIssued: Amount.from(10),
    };

    const watcher = makeWatcher({
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });
    expect(subscribe).toHaveBeenCalledTimes(1);

    await bus.emit('mint-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: completedQuote,
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('releases quote watches when the mint is untrusted', async () => {
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
    expect(subscribe).toHaveBeenCalledTimes(1);

    await bus.emit('mint:untrusted', { mintUrl });

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps BOLT12 quote watching across operation executing, finalized and failed events', async () => {
    const operation = makeBolt12Operation();

    const watcher = makeWatcher({
      mintOperations: {
        getPendingOperations: mock(async () => [operation]),
      } as unknown as MintOperationService,
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    expect(subscribe).toHaveBeenCalledTimes(1);

    await bus.emit('mint-op:executing', {
      mintUrl,
      operationId: operation.id,
      operation: { ...operation, state: 'executing' } as unknown as MintOperation,
    });
    await bus.emit('mint-op:finalized', {
      mintUrl,
      operationId: operation.id,
      operation: { ...operation, state: 'finalized' } as unknown as FinalizedMintOperation,
    });
    await bus.emit('mint-op:failed', {
      mintUrl,
      operationId: operation.id,
      operation: makeFailedOperation(operation as unknown as PendingMintOperation),
    });

    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  const expectWatchKeptWhenOperationEventArrivesDuringAcquisition = async (
    emitOperationEvent: (operation: PendingMintOperation) => Promise<void>,
  ) => {
    const operation = makePendingOperation();
    let releaseSubscribe: (() => void) | undefined;
    const subscribeGate = new Promise<void>((resolve) => {
      releaseSubscribe = resolve;
    });
    subscribe = mock(async () => {
      await subscribeGate;
      return { subId: 'sub-1', unsubscribe };
    });

    const watcher = makeWatcher({
      options: { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    const pendingEmit = bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscribe).toHaveBeenCalledTimes(1);

    await emitOperationEvent(operation);

    releaseSubscribe?.();
    await pendingEmit;

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  };

  it('keeps the quote watch when an operation starts executing while subscription is being acquired', async () => {
    await expectWatchKeptWhenOperationEventArrivesDuringAcquisition((operation) =>
      bus.emit('mint-op:executing', {
        mintUrl,
        operationId: operation.id,
        operation: { ...operation, state: 'executing' } as unknown as MintOperation,
      }),
    );
  });

  it('keeps the quote watch when an operation finalizes while subscription is being acquired', async () => {
    await expectWatchKeptWhenOperationEventArrivesDuringAcquisition((operation) =>
      bus.emit('mint-op:finalized', {
        mintUrl,
        operationId: operation.id,
        operation: { ...operation, state: 'finalized' },
      }),
    );
  });

  it('keeps the quote watch when an operation fails while subscription is being acquired', async () => {
    await expectWatchKeptWhenOperationEventArrivesDuringAcquisition((operation) =>
      bus.emit('mint-op:failed', {
        mintUrl,
        operationId: operation.id,
        operation: makeFailedOperation(operation),
      }),
    );
  });
});
