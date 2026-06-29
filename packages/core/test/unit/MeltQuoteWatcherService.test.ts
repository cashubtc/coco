import {
  Amount,
  type MeltQuoteBolt11Response,
  type MeltQuoteOnchainResponse,
} from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import { NullLogger } from '../../logging/NullLogger.ts';
import type { MeltQuote } from '../../models/MeltQuote.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import {
  MeltQuoteWatcherService,
  type MeltQuoteWatcherOptions,
} from '../../services/watchers/MeltQuoteWatcherService.ts';
import type { MintService } from '../../services/MintService.ts';

describe('MeltQuoteWatcherService', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'melt-quote-1';

  let bus: EventBus<CoreEvents>;
  let subscribe: Mock<any>;
  let unsubscribe: Mock<any>;
  let callbacks: Array<
    (payload: MeltQuoteBolt11Response | MeltQuoteOnchainResponse | string) => Promise<void>
  >;

  const futureExpiry = () => Math.floor(Date.now() / 1000) + 3600;
  const pastExpiry = () => Math.floor(Date.now() / 1000) - 1;

  const makeBolt11Quote = (overrides: Partial<MeltQuote<'bolt11'>> = {}): MeltQuote<'bolt11'> => ({
    mintUrl,
    method: 'bolt11',
    quoteId,
    quote: quoteId,
    request: 'lnbc1test',
    amount: Amount.from(10),
    unit: 'sat',
    fee_reserve: Amount.from(1),
    expiry: futureExpiry(),
    state: 'PENDING',
    payment_preimage: null,
    change: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  const makeOnchainQuote = (
    overrides: Partial<MeltQuote<'onchain'>> = {},
  ): MeltQuote<'onchain'> => ({
    mintUrl,
    method: 'onchain',
    quoteId,
    quote: quoteId,
    request: 'bc1ptest',
    amount: Amount.from(10),
    unit: 'sat',
    fee_options: [
      {
        fee_index: 0,
        fee_reserve: Amount.from(1),
        estimated_blocks: 2,
      },
    ],
    expiry: futureExpiry(),
    state: 'PENDING',
    change: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  const makeQuoteLifecycle = (
    overrides: Partial<
      Pick<
        QuoteLifecycle,
        'getPendingMeltQuotes' | 'getMeltQuote' | 'recordMeltQuoteObservation' | 'refreshMeltQuote'
      >
    > = {},
  ): QuoteLifecycle =>
    ({
      getPendingMeltQuotes: mock(async () => []),
      getMeltQuote: mock(async () => makeBolt11Quote()),
      recordMeltQuoteObservation: mock(async (quote: MeltQuote) => quote),
      refreshMeltQuote: mock(async () => makeBolt11Quote({ state: 'PAID' })),
      ...overrides,
    }) as unknown as QuoteLifecycle;

  const makeWatcher = ({
    mintService = { isTrustedMint: mock(async () => true) } as unknown as MintService,
    quoteLifecycle = makeQuoteLifecycle(),
    options,
  }: {
    mintService?: MintService;
    quoteLifecycle?: QuoteLifecycle;
    options?: MeltQuoteWatcherOptions;
  } = {}): MeltQuoteWatcherService =>
    new MeltQuoteWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      mintService,
      quoteLifecycle,
      bus,
      new NullLogger(),
      options,
    );

  beforeEach(() => {
    bus = new EventBus<CoreEvents>();
    unsubscribe = mock(async () => {});
    callbacks = [];
    subscribe = mock(
      async (
        _mintUrl: string,
        _kind: string,
        _filters: string[],
        next: (
          payload: MeltQuoteBolt11Response | MeltQuoteOnchainResponse | string,
        ) => Promise<void>,
      ) => {
        callbacks.push(next);
        return { subId: `sub-${callbacks.length}`, unsubscribe };
      },
    );
  });

  it('watches existing pending canonical melt quotes on startup', async () => {
    const bolt11Quote = makeBolt11Quote();
    const onchainQuote = makeOnchainQuote();
    const getPendingMeltQuotes = mock(async () => [bolt11Quote, onchainQuote]);
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({ getPendingMeltQuotes }),
    });

    await watcher.start();

    expect(getPendingMeltQuotes).toHaveBeenCalledWith();
    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt11_melt_quote',
      [quoteId],
      expect.any(Function),
    );
    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'onchain_melt_quote',
      [quoteId],
      expect.any(Function),
    );

    await watcher.stop();
  });

  it('watches new pending canonical melt quotes while running', async () => {
    const watcher = makeWatcher({
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: makeBolt11Quote(),
    });

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt11_melt_quote',
      [quoteId],
      expect.any(Function),
    );

    await watcher.stop();
  });

  it('watches newly created unpaid canonical melt quotes while running', async () => {
    const watcher = makeWatcher({
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: makeBolt11Quote({ state: 'UNPAID' }),
    });

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt11_melt_quote',
      [quoteId],
      expect.any(Function),
    );

    await watcher.stop();
  });

  it('records full subscription payloads as canonical melt quote observations', async () => {
    const recordMeltQuoteObservation = mock(async (quote: MeltQuote) => quote);
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({ recordMeltQuoteObservation }),
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: makeBolt11Quote(),
    });

    await callbacks[0]?.({
      quote: quoteId,
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      fee_reserve: Amount.from(1),
      expiry: futureExpiry(),
      state: 'PAID',
      payment_preimage: 'preimage',
      change: [],
    });

    expect(recordMeltQuoteObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        mintUrl,
        method: 'bolt11',
        quoteId,
        state: 'PAID',
        payment_preimage: 'preimage',
      }),
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('records polling state payloads without mutating proofs or operations', async () => {
    const existing = makeBolt11Quote({ state: 'PENDING' });
    const getMeltQuote = mock(async () => existing);
    const recordMeltQuoteObservation = mock(async (quote: MeltQuote) => quote);
    const forbiddenMutation = mock(async () => {
      throw new Error('proof or operation mutation is out of scope');
    });
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getMeltQuote,
        recordMeltQuoteObservation,
      }),
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: existing,
    });

    await callbacks[0]?.('UNPAID');

    expect(getMeltQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', quoteId);
    expect(recordMeltQuoteObservation).toHaveBeenCalledWith(
      expect.objectContaining({ quoteId, state: 'UNPAID' }),
    );
    expect(forbiddenMutation).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('refreshes full quote data for state-only PAID payloads before stopping', async () => {
    const existing = makeBolt11Quote({ state: 'PENDING' });
    const refreshMeltQuote = mock(async () =>
      makeBolt11Quote({ state: 'PAID', payment_preimage: 'preimage' }),
    );
    const recordMeltQuoteObservation = mock(async (quote: MeltQuote) => quote);
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getMeltQuote: mock(async () => existing),
        refreshMeltQuote,
        recordMeltQuoteObservation,
      }),
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: existing,
    });

    await callbacks[0]?.('PAID');

    expect(refreshMeltQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', quoteId);
    expect(recordMeltQuoteObservation).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('keeps a shared watch until canonical and operation interest are both removed', async () => {
    const quote = makeBolt11Quote();
    const watcher = makeWatcher({
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote,
    });
    await watcher.registerOperationInterest({
      operationId: 'melt-op-1',
      mintUrl,
      method: 'bolt11',
      quoteId,
    });

    expect(subscribe).toHaveBeenCalledTimes(1);

    await bus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: { ...quote, expiry: pastExpiry() },
    });

    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.removeOperationInterest('melt-op-1');

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('unwatches terminal PAID canonical quotes', async () => {
    const quote = makeBolt11Quote();
    const watcher = makeWatcher({
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote,
    });
    await bus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: { ...quote, state: 'PAID' },
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('skips expired canonical quotes without operation interest', async () => {
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getPendingMeltQuotes: mock(async () => [
          makeBolt11Quote({
            expiry: pastExpiry(),
          }),
        ]),
      }),
    });

    await watcher.start();

    expect(subscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('stops watches for a mint when it becomes untrusted', async () => {
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getPendingMeltQuotes: mock(async () => [
          makeBolt11Quote({ quoteId: 'melt-quote-1' }),
          makeBolt11Quote({ quoteId: 'melt-quote-2', quote: 'melt-quote-2' }),
        ]),
      }),
    });

    await watcher.start();
    expect(subscribe).toHaveBeenCalledTimes(2);

    await bus.emit('mint:untrusted', { mintUrl });

    expect(unsubscribe).toHaveBeenCalledTimes(2);

    await watcher.stop();
  });
});
