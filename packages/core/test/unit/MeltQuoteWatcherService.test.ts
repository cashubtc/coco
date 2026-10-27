import {
  Amount,
  type MeltQuoteBolt11Response,
  type MeltQuoteOnchainResponse,
} from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { deferred } from '../fixtures/MintSwapRuntime.ts';
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
  let callbacks: Array<(payload: unknown) => Promise<void>>;

  const futureExpiry = () => Math.floor(Date.now() / 1000) + 3600;
  const pastExpiry = () => Math.floor(Date.now() / 1000) - 1;
  const flushPromises = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const waitForSubscribeCalls = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (subscribe.mock.calls.length >= count) return;
      await flushPromises();
    }
    throw new Error(`Expected ${count} subscribe calls, saw ${subscribe.mock.calls.length}`);
  };

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
        next: (payload: MeltQuoteBolt11Response | MeltQuoteOnchainResponse) => Promise<void>,
      ) => {
        callbacks.push(next as (payload: unknown) => Promise<void>);
        return { subId: `sub-${callbacks.length}`, unsubscribe };
      },
    );
  });

  it('keeps recovery observation registered while another owner removal awaits trust', async () => {
    const entered = deferred();
    const release = deferred();
    let removing = false;
    const watcher = makeWatcher({
      mintService: {
        isTrustedMint: async () => {
          if (!removing) return true;
          entered.resolve();
          await release.promise;
          return false;
        },
      } as unknown as MintService,
    });
    await watcher.start();
    const identity = { mintUrl, method: 'bolt11' as const, quoteId };
    const first = { kind: 'mint-swap' as const, id: 'first', recovery: true };
    const next = { kind: 'mint-swap' as const, id: 'next', recovery: true };
    await watcher.registerInterest({ ...identity, owner: { kind: 'canonical', id: 'canonical' } });
    await watcher.registerInterest({ ...identity, owner: first });
    removing = true;
    const removal = watcher.removeInterest(first);
    await entered.promise;
    await watcher.registerInterest({ ...identity, owner: next });
    release.resolve();
    await removal;
    try {
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(watcher.hasRecoveryInterest(identity)).toBe(true);
    } finally {
      await watcher.stop();
    }
  });

  it('makes overlapping stop calls wait for the same subscription cleanup', async () => {
    const entered = deferred();
    const release = deferred();
    unsubscribe.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    const watcher = makeWatcher();
    await watcher.start();
    await watcher.registerInterest({
      mintUrl,
      method: 'bolt11',
      quoteId,
      owner: { kind: 'mint-swap', id: 'parent', recovery: true },
    });
    const first = watcher.stop();
    await entered.promise;
    let secondFinished = false;
    const second = watcher.stop().then(() => {
      secondFinished = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    const finishedBeforeCleanup = secondFinished;
    release.resolve();
    await Promise.all([first, second]);
    expect(finishedBeforeCleanup).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('awaits shared subscription acquisition and permits retry after acquisition fails', async () => {
    const acquisition = deferred();
    subscribe.mockImplementationOnce(async () => {
      await acquisition.promise;
      throw new Error('subscription unavailable');
    });
    const watcher = makeWatcher();
    await watcher.start();
    const interest = {
      mintUrl,
      method: 'bolt11' as const,
      quoteId,
      owner: { kind: 'mint-swap' as const, id: 'swap', recovery: true },
    };
    let settled = false;
    const registration = watcher.registerInterest(interest).finally(() => {
      settled = true;
    });
    // Install the rejection observer before releasing acquisition.
    const rejected = registration.catch((error: unknown) => error);
    await waitForSubscribeCalls(1);
    expect(settled).toBe(false);
    acquisition.resolve();
    expect(await rejected).toEqual(new Error('subscription unavailable'));
    await watcher.registerInterest(interest);
    expect(subscribe).toHaveBeenCalledTimes(2);
    await watcher.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect an owner removed during its canonical quote lookup', async () => {
    const entered = deferred();
    const release = deferred();
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({
        getMeltQuote: mock(async () => {
          entered.resolve();
          await release.promise;
          return makeBolt11Quote();
        }),
      }),
    });
    await watcher.start();
    const owner = { kind: 'mint-swap' as const, id: 'swap', recovery: true };
    const registration = watcher.registerInterest({ mintUrl, method: 'bolt11', quoteId, owner });
    await entered.promise;
    await watcher.removeInterest(owner);
    release.resolve();
    await registration;
    expect(subscribe).not.toHaveBeenCalled();
    expect(watcher.hasRecoveryInterest({ mintUrl, method: 'bolt11', quoteId })).toBe(false);
    await watcher.stop();
  });

  it('keeps ordinary and parent owners independent, including identical IDs', async () => {
    const watcher = makeWatcher();
    await watcher.start();
    await watcher.registerOperationInterest({
      operationId: 'same-id',
      mintUrl,
      method: 'bolt11',
      quoteId,
    });
    const owner = { kind: 'mint-swap' as const, id: 'same-id', recovery: true };
    await watcher.registerInterest({ mintUrl: `${mintUrl}/`, method: 'bolt11', quoteId, owner });
    await watcher.registerInterest({ mintUrl, method: 'bolt11', quoteId, owner });
    expect(subscribe).toHaveBeenCalledTimes(1);
    await watcher.removeInterest(owner);
    expect(unsubscribe).not.toHaveBeenCalled();
    await watcher.removeOperationInterest('same-id');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await watcher.stop();
  });

  it('retains only exact recovery observation after untrust and expiry', async () => {
    let trusted = true;
    const watcher = makeWatcher({
      mintService: { isTrustedMint: async () => trusted } as unknown as MintService,
      quoteLifecycle: makeQuoteLifecycle({
        getMeltQuote: async () => makeBolt11Quote({ expiry: pastExpiry() }),
      }),
    });
    await watcher.start();
    const owner = { kind: 'mint-swap' as const, id: 'parent', recovery: true };
    await watcher.registerInterest({ mintUrl, method: 'bolt11', quoteId, owner });
    await watcher.registerOperationInterest({
      operationId: 'ordinary',
      mintUrl,
      method: 'bolt11',
      quoteId: 'other',
    });
    trusted = false;
    await bus.emit('mint:untrusted', { mintUrl });
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(watcher.hasRecoveryInterest({ mintUrl, method: 'bolt11', quoteId })).toBe(true);
    await watcher.removeInterest(owner);
    expect(unsubscribe).toHaveBeenCalledTimes(3);
    await watcher.stop();
  });

  it('drains an admitted observation before stop and ignores late notifications', async () => {
    let release!: () => void;
    let entered!: () => void;
    const arrival = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const record = mock(async (quote: MeltQuote) => {
      entered();
      await gate;
      return quote;
    });
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({ recordMeltQuoteObservation: record }),
    });
    await watcher.start();
    await watcher.registerOperationInterest({
      operationId: 'op',
      mintUrl,
      method: 'bolt11',
      quoteId,
    });
    const observation = callbacks[0]!(makeBolt11Quote({ state: 'PENDING' }));
    await arrival;
    let stopped = false;
    const stopping = watcher.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await observation;
    await stopping;
    await callbacks[0]!(makeBolt11Quote({ state: 'UNPAID' }));
    expect(record).toHaveBeenCalledTimes(1);
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

  it.each([{ change: [] }, { change: undefined }])(
    'records a full PAID payload with change %j without refreshing',
    async ({ change }) => {
      const recordMeltQuoteObservation = mock(async (quote: MeltQuote) => quote);
      const quoteLifecycle = makeQuoteLifecycle({ recordMeltQuoteObservation });
      const watcher = makeWatcher({
        quoteLifecycle,
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
        amount: '10',
        unit: 'sat',
        fee_reserve: '1',
        expiry: futureExpiry(),
        state: 'PAID',
        payment_preimage: 'preimage',
        change,
      });

      expect(recordMeltQuoteObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          mintUrl,
          method: 'bolt11',
          quoteId,
          state: 'PAID',
          payment_preimage: 'preimage',
          change: [],
        }),
      );
      const observedQuote = recordMeltQuoteObservation.mock.calls[0]?.[0] as MeltQuote<'bolt11'>;
      expect(observedQuote.amount.equals(Amount.from(10))).toBe(true);
      expect(observedQuote.fee_reserve.equals(Amount.from(1))).toBe(true);
      expect(quoteLifecycle.refreshMeltQuote).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledTimes(1);

      await watcher.stop();
    },
  );

  it('normalizes onchain full subscription amount payloads', async () => {
    const recordMeltQuoteObservation = mock(async (quote: MeltQuote) => quote);
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({ recordMeltQuoteObservation }),
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    await bus.emit('melt-quote:updated', {
      mintUrl,
      method: 'onchain',
      quoteId,
      quote: makeOnchainQuote(),
    });

    await callbacks[0]?.({
      quote: quoteId,
      request: 'bc1ptest',
      amount: '10',
      unit: 'sat',
      fee_options: [{ fee_index: 0, fee_reserve: '2', estimated_blocks: 2 }],
      selected_fee_index: null,
      outpoint: null,
      expiry: futureExpiry(),
      state: 'PAID',
      change: [],
    });

    const observedQuote = recordMeltQuoteObservation.mock.calls[0]?.[0] as MeltQuote<'onchain'>;
    expect(observedQuote.amount.equals(Amount.from(10))).toBe(true);
    expect(observedQuote.fee_options[0]?.fee_reserve.equals(Amount.from(2))).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it.each([
    'PAID',
    'UNPAID',
    { quote: quoteId, state: 'PAID' },
    { quote: quoteId, state: 'UNPAID' },
  ])('ignores malformed notification payload %j without refreshing', async (payload) => {
    const getMeltQuote = mock(async () => makeBolt11Quote());
    const quoteLifecycle = makeQuoteLifecycle({ getMeltQuote });
    const watcher = makeWatcher({
      quoteLifecycle,
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    try {
      await watcher.registerOperationInterest({
        operationId: 'melt-op-1',
        mintUrl,
        method: 'bolt11',
        quoteId,
      });
      // Registration reads the canonical quote; malformed notifications must do no further work.
      expect(getMeltQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', quoteId);
      getMeltQuote.mockClear();
      await callbacks[0]?.(payload);

      expect(quoteLifecycle.recordMeltQuoteObservation).not.toHaveBeenCalled();
      expect(quoteLifecycle.getMeltQuote).not.toHaveBeenCalled();
      expect(quoteLifecycle.refreshMeltQuote).not.toHaveBeenCalled();
      expect(unsubscribe).not.toHaveBeenCalled();
    } finally {
      await watcher.stop();
    }
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

  it('drops expired canonical startup interest while operation watch continues', async () => {
    let resolvePendingQuotes: ((quotes: MeltQuote[]) => void) | undefined;
    const getPendingMeltQuotes = mock(
      () =>
        new Promise<MeltQuote[]>((resolve) => {
          resolvePendingQuotes = resolve;
        }),
    );
    const watcher = makeWatcher({
      quoteLifecycle: makeQuoteLifecycle({ getPendingMeltQuotes }),
    });

    const start = watcher.start();
    await watcher.registerOperationInterest({
      operationId: 'melt-op-1',
      mintUrl,
      method: 'bolt11',
      quoteId,
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    if (!resolvePendingQuotes) {
      throw new Error('Expected startup pending quote load to be waiting');
    }

    resolvePendingQuotes([makeBolt11Quote({ expiry: pastExpiry() })]);
    await start;

    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.removeOperationInterest('melt-op-1');

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('drops canonical interest after subscription observes an expired quote', async () => {
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

    await callbacks[0]?.({
      quote: quoteId,
      request: 'lnbc1test',
      amount: '10',
      unit: 'sat',
      fee_reserve: '1',
      expiry: pastExpiry(),
      state: 'PENDING',
      payment_preimage: null,
      change: [],
    });

    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.removeOperationInterest('melt-op-1');

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('does not subscribe if stopped while trust check is pending', async () => {
    let resolveTrusted: ((trusted: boolean) => void) | undefined;
    const isTrustedMint = mock(
      () =>
        new Promise<boolean>((resolve) => {
          resolveTrusted = resolve;
        }),
    );
    const watcher = makeWatcher({
      mintService: { isTrustedMint } as unknown as MintService,
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    const watch = watcher.registerOperationInterest({
      operationId: 'melt-op-1',
      mintUrl,
      method: 'bolt11',
      quoteId,
    });
    await flushPromises();

    expect(isTrustedMint).toHaveBeenCalledWith(mintUrl);
    expect(subscribe).not.toHaveBeenCalled();

    const stop = watcher.stop();
    await flushPromises();
    if (!resolveTrusted) {
      throw new Error('Expected trust check to be waiting');
    }
    resolveTrusted(true);

    await Promise.all([watch, stop]);

    expect(subscribe).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('waits for pending subscription cleanup before stop resolves', async () => {
    const resolveSubscribe: Array<() => void> = [];
    const pendingUnsubscribe = mock(async () => {});
    subscribe = mock(
      (
        _mintUrl: string,
        _kind: string,
        _filters: string[],
        next: (payload: MeltQuoteBolt11Response | MeltQuoteOnchainResponse) => Promise<void>,
      ) => {
        callbacks.push(next as (payload: unknown) => Promise<void>);
        return new Promise<{ subId: string; unsubscribe: () => Promise<void> }>((resolve) => {
          resolveSubscribe.push(() => resolve({ subId: 'sub-1', unsubscribe: pendingUnsubscribe }));
        });
      },
    );
    const watcher = makeWatcher({
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    const watch = watcher.registerOperationInterest({
      operationId: 'melt-op-1',
      mintUrl,
      method: 'bolt11',
      quoteId,
    });
    await waitForSubscribeCalls(1);

    let stopped = false;
    const stop = watcher.stop().then(() => {
      stopped = true;
    });
    await flushPromises();

    expect(stopped).toBe(false);

    resolveSubscribe[0]?.();
    await Promise.all([watch, stop]);

    expect(pendingUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping watch requests while subscribe is pending', async () => {
    const resolveSubscribe: Array<() => void> = [];
    const firstUnsubscribe = mock(async () => {});
    subscribe = mock(
      (
        _mintUrl: string,
        _kind: string,
        _filters: string[],
        next: (payload: MeltQuoteBolt11Response | MeltQuoteOnchainResponse) => Promise<void>,
      ) => {
        const subId = `sub-${callbacks.length + 1}`;
        callbacks.push(next as (payload: unknown) => Promise<void>);
        return new Promise<{ subId: string; unsubscribe: () => Promise<void> }>((resolve) => {
          resolveSubscribe.push(() => resolve({ subId, unsubscribe: firstUnsubscribe }));
        });
      },
    );
    const watcher = makeWatcher({
      options: { watchExistingPendingQuotesOnStart: false },
    });

    await watcher.start();
    const firstWatch = watcher.registerOperationInterest({
      operationId: 'melt-op-1',
      mintUrl,
      method: 'bolt11',
      quoteId,
    });
    await waitForSubscribeCalls(1);

    const secondWatch = watcher.registerOperationInterest({
      operationId: 'melt-op-2',
      mintUrl,
      method: 'bolt11',
      quoteId,
    });
    await flushPromises();

    expect(subscribe).toHaveBeenCalledTimes(1);

    resolveSubscribe[0]?.();
    await Promise.all([firstWatch, secondWatch]);

    await watcher.removeOperationInterest('melt-op-1');
    expect(firstUnsubscribe).not.toHaveBeenCalled();

    await watcher.removeOperationInterest('melt-op-2');
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);

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
