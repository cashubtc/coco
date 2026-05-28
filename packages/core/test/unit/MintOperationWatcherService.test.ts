import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { MintOperationWatcherService } from '../../services/watchers/MintOperationWatcherService.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { MintService } from '../../services/MintService.ts';
import type { MintOperationService } from '../../operations/mint/MintOperationService.ts';
import type { PendingMintOperation } from '../../operations/mint/MintOperation.ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import { NullLogger } from '../../logging/NullLogger.ts';
import type { MintQuoteBolt11Response } from '@cashu/cashu-ts';

describe('MintOperationWatcherService', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-1';

  let bus: EventBus<CoreEvents>;
  let subscribe: Mock<any>;
  let unsubscribe: Mock<any>;
  let callback: ((payload: MintQuoteBolt11Response) => Promise<void>) | undefined;

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
    lastObservedRemoteState: 'UNPAID',
    lastObservedRemoteStateAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
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
    lastObservedRemoteState: 'UNPAID',
    lastObservedRemoteStateAt: Date.now(),
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
    lastObservedRemoteStateAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  beforeEach(() => {
    bus = new EventBus<CoreEvents>();
    unsubscribe = mock(async () => {});
    callback = undefined;
    subscribe = mock(
      async (
        _mintUrl: string,
        _kind: string,
        _filters: string[],
        next: (payload: MintQuoteBolt11Response) => Promise<void>,
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
    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getPendingMintQuotes,
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false },
    );

    await watcher.start();

    expect(getPendingMintQuotes).toHaveBeenCalledWith();
    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt11_mint_quote',
      [quoteId],
      expect.any(Function),
    );

    await watcher.stop();
  });

  it('does not watch pending canonical mint quotes without a policy', async () => {
    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getPendingMintQuotes: mock(async () => [makeOnchainQuote()]),
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false },
    );

    await watcher.start();

    expect(subscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('does not start watching already expired canonical mint quotes', async () => {
    const expiredQuote = {
      ...makeBolt11Quote(),
      expiry: Math.floor(Date.now() / 1000) - 1,
    };
    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getPendingMintQuotes: mock(async () => [expiredQuote]),
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false },
    );

    await watcher.start();

    expect(subscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('does not watch pending mint operations without a policy', async () => {
    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getPendingOperations: mock(async () => [makeOnchainOperation()]),
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingQuotesOnStart: false },
    );

    await watcher.start();

    expect(subscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('watches canonical mint quotes created after startup', async () => {
    const quote = makeBolt11Quote();
    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {} as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    );

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
        method: 'bolt11',
        quoteId: quote.quote,
        quote: quote.quote,
        request: quote.request,
        amount: quote.amount,
        unit: quote.unit,
        expiry: quote.expiry,
        state: quote.state,
        reusable: false,
        createdAt: operation.createdAt,
        updatedAt: Date.now(),
      }),
    );
    const getOperation = mock(async () => {
      throw new Error('should not need an operation');
    });

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        observePendingOperation,
        getOperation,
        recordMintQuoteSnapshot,
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    );

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

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        recordMintQuoteSnapshot,
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    );

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
        method: 'bolt11',
        quoteId: quote.quote,
        quote: quote.quote,
        request: quote.request,
        amount: quote.amount,
        unit: quote.unit,
        expiry: quote.expiry,
        state: quote.state,
        reusable: false,
        createdAt: operation.createdAt,
        updatedAt: Date.now(),
      }),
    );

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getOperation: mock(async () => operation),
        recordMintQuoteSnapshot,
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    );

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

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {} as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    );

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

  it('does not unsubscribe while canonical interest remains after an operation finalizes', async () => {
    const quote = makeBolt11Quote();
    const operation = makePendingOperation();

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {} as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false, watchExistingPendingQuotesOnStart: false },
    );

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

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getPendingOperations: mock(async () => [first, second]),
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingQuotesOnStart: false },
    );

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
});
