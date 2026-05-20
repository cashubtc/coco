import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { MintOperationWatcherService } from '../../services/watchers/MintOperationWatcherService.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { MintService } from '../../services/MintService.ts';
import type { MintOperationService } from '../../operations/mint/MintOperationService.ts';
import type { PendingMintOperation } from '../../operations/mint/MintOperation.ts';
import { NullLogger } from '../../logging/NullLogger.ts';
import type { MintQuoteBolt11Response, MintQuoteBolt12Response } from '@cashu/cashu-ts';

type MintQuotePayload = MintQuoteBolt11Response | MintQuoteBolt12Response;
type SubscribeFn = (
  mintUrl: string,
  kind: string,
  filters: string[],
  next: (payload: MintQuotePayload) => Promise<void>,
) => Promise<{ subId: string; unsubscribe: () => Promise<void> }>;

describe('MintOperationWatcherService', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-1';

  let bus: EventBus<CoreEvents>;
  let subscribe: Mock<SubscribeFn>;
  let unsubscribe: Mock<() => Promise<void>>;
  let callbacks: Array<(payload: MintQuotePayload) => Promise<void>>;

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

  const makeBolt12PendingOperation = (
    id: string,
    amount = Amount.from(10),
  ): PendingMintOperation<'bolt12'> => ({
    ...makePendingOperation(),
    id,
    method: 'bolt12',
    methodData: { amountless: true },
    amount,
    request: 'lno1test',
    pubkey: `pubkey-${id}`,
    lastObservedRemoteState: 'UNPAID',
  });

  beforeEach(() => {
    bus = new EventBus<CoreEvents>();
    unsubscribe = mock(async () => {});
    callbacks = [];
    subscribe = mock(
      async (
        _mintUrl: string,
        _kind: string,
        _filters: string[],
        next: (payload: MintQuotePayload) => Promise<void>,
      ) => {
        callbacks.push(next);
        return { subId: 'sub-1', unsubscribe };
      },
    );
  });

  it('records PAID subscription updates without re-checking the quote remotely', async () => {
    const operation = makePendingOperation();
    const observePendingOperation = mock(async () => {
      throw new Error('should not re-check');
    });
    const recordQuoteObservation = mock(
      async (_operation: PendingMintOperation, _state: 'UNPAID' | 'PAID' | 'ISSUED') => ({
        mintUrl,
        method: 'bolt11',
        quoteId,
        quote: quoteId,
        request: operation.request,
        amount: operation.amount,
        unit: operation.unit,
        expiry: operation.expiry,
        state: 'PAID',
        reusable: false,
        createdAt: operation.createdAt,
        updatedAt: Date.now(),
      }),
    );
    const getOperation = mock(async () => operation);

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        observePendingOperation,
        getOperation,
        recordQuoteObservation,
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false },
    );

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    const callback = callbacks[0];
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

    expect(getOperation).toHaveBeenCalledWith(operation.id);
    expect(observePendingOperation).not.toHaveBeenCalled();
    expect(recordQuoteObservation).toHaveBeenCalledTimes(1);
    const [paidOperation, state] = recordQuoteObservation.mock.calls[0] ?? [];
    expect(state).toBe('PAID');
    if (!paidOperation || paidOperation.state !== 'pending') {
      throw new Error('Expected pending operation in PAID observation');
    }
    expect(paidOperation.lastObservedRemoteState).toBe('PAID');
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('records ISSUED subscription updates and stops watching the operation', async () => {
    const operation = makePendingOperation();
    const recordQuoteObservation = mock(
      async (_operation: PendingMintOperation, _state: 'UNPAID' | 'PAID' | 'ISSUED') => ({
        mintUrl,
        method: 'bolt11',
        quoteId,
        quote: quoteId,
        request: operation.request,
        amount: operation.amount,
        unit: operation.unit,
        expiry: operation.expiry,
        state: 'ISSUED',
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
        recordQuoteObservation,
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false },
    );

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operation.id,
      operation,
    });

    const callback = callbacks[0];
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

    expect(recordQuoteObservation).toHaveBeenCalledTimes(1);
    const [issuedOperation, state] = recordQuoteObservation.mock.calls[0] ?? [];
    expect(state).toBe('ISSUED');
    if (!issuedOperation || issuedOperation.state !== 'pending') {
      throw new Error('Expected pending operation in ISSUED observation');
    }
    expect(issuedOperation.lastObservedRemoteState).toBe('ISSUED');
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('watches BOLT12 operations independently when they share a quote id', async () => {
    const operationA = makeBolt12PendingOperation('mint-op-a');
    const operationB = makeBolt12PendingOperation('mint-op-b');
    const operations = new Map<string, PendingMintOperation>([
      [operationA.id, operationA],
      [operationB.id, operationB],
    ]);
    const quoteStateEvents: Array<CoreEvents['mint-op:quote-state-changed']> = [];
    bus.on('mint-op:quote-state-changed', (event) => {
      quoteStateEvents.push(event);
    });

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getOperation: mock(async (operationId: string) => operations.get(operationId) ?? null),
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false },
    );

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operationA.id,
      operation: operationA,
    });
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: operationB.id,
      operation: operationB,
    });

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe.mock.calls[0]?.[1]).toBe('bolt12_mint_quote');
    expect(subscribe.mock.calls[1]?.[1]).toBe('bolt12_mint_quote');
    expect(subscribe.mock.calls[0]?.[2]).toEqual([quoteId]);
    expect(subscribe.mock.calls[1]?.[2]).toEqual([quoteId]);

    const quote: MintQuoteBolt12Response = {
      quote: quoteId,
      request: 'lno1test',
      unit: 'sat',
      amount: undefined,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      pubkey: 'pubkey',
      amount_paid: Amount.from(20),
      amount_issued: Amount.zero(),
    };

    await callbacks[0]!(quote);
    await callbacks[1]!(quote);

    expect(quoteStateEvents).toHaveLength(2);
    expect(quoteStateEvents.map((event) => event.operationId).sort()).toEqual([
      operationA.id,
      operationB.id,
    ]);
    expect(quoteStateEvents.every((event) => event.state === 'PAID')).toBe(true);

    await watcher.stop();
  });
});
