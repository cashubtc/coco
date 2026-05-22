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
    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getPendingMintQuotes: mock(async () => [quote]),
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false },
    );

    await watcher.start();

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt11_mint_quote',
      [quoteId],
      expect.any(Function),
    );

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
});
