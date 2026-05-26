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
type RecordQuoteObservationFn = (
  operation: PendingMintOperation,
  state: 'UNPAID' | 'PAID' | 'ISSUED',
  observedAt?: number,
) => Promise<unknown>;
type RecordPendingObservationFn = (
  operationId: string,
  state: 'UNPAID' | 'PAID' | 'ISSUED',
  observedAt?: number,
) => Promise<unknown>;

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
    const getOperationsForQuote = mock(async () => [operation]);
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
        getOperationsForQuote,
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

    expect(getOperationsForQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', operation.quoteId);
    expect(getOperation).not.toHaveBeenCalled();
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
        getOperationsForQuote: mock(async () => [operation]),
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

  it('deduplicates BOLT12 watches by quote and records the canonical quote observation', async () => {
    const operationA = makeBolt12PendingOperation('mint-op-a');
    const operationB = makeBolt12PendingOperation('mint-op-b');
    const operations = new Map<string, PendingMintOperation>([
      [operationA.id, operationA],
      [operationB.id, operationB],
    ]);
    const recordQuoteObservation: Mock<RecordQuoteObservationFn> = mock(async () => undefined);

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getOperationsForQuote: mock(async () => Array.from(operations.values())),
        recordQuoteObservation,
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

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0]?.[1]).toBe('bolt12_mint_quote');
    expect(subscribe.mock.calls[0]?.[2]).toEqual([quoteId]);

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

    expect(recordQuoteObservation).toHaveBeenCalledTimes(2);
    const observationCalls = recordQuoteObservation.mock.calls as unknown as Array<
      [PendingMintOperation, 'UNPAID' | 'PAID' | 'ISSUED']
    >;
    expect(observationCalls.map(([operation]) => operation.id).sort()).toEqual([
      operationA.id,
      operationB.id,
    ]);
    expect(observationCalls.every(([, state]) => state === 'PAID')).toBe(true);

    await watcher.stop();
  });

  it('allocates partial BOLT12 paid capacity across reusable quote operations once', async () => {
    const createdAt = Date.now();
    const operationA = {
      ...makeBolt12PendingOperation('mint-op-a', Amount.from(10)),
      createdAt,
    };
    const operationB = {
      ...makeBolt12PendingOperation('mint-op-b', Amount.from(10)),
      createdAt: createdAt + 1,
    };
    const operations = new Map<string, PendingMintOperation>([
      [operationA.id, operationA],
      [operationB.id, operationB],
    ]);
    const recordQuoteObservation: Mock<RecordQuoteObservationFn> = mock(async () => undefined);

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getOperationsForQuote: mock(async () => Array.from(operations.values())),
        recordQuoteObservation,
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

    await callbacks[0]!({
      quote: quoteId,
      request: 'lno1test',
      unit: 'sat',
      amount: undefined,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      pubkey: 'pubkey',
      amount_paid: Amount.from(20),
      amount_issued: Amount.from(10),
    });

    expect(recordQuoteObservation).toHaveBeenCalledTimes(1);
    const [paidOperation, state] = recordQuoteObservation.mock.calls[0] ?? [];
    expect(paidOperation?.id).toBe(operationA.id);
    expect(state).toBe('PAID');

    await watcher.stop();
  });

  it('keeps already-paid BOLT12 operations ahead of unpaid operations during allocation', async () => {
    const createdAt = Date.now();
    const unpaidOperation = {
      ...makeBolt12PendingOperation('mint-op-unpaid', Amount.from(10)),
      createdAt,
      lastObservedRemoteState: 'UNPAID' as const,
    };
    const paidOperation = {
      ...makeBolt12PendingOperation('mint-op-paid', Amount.from(10)),
      createdAt: createdAt + 1,
      lastObservedRemoteState: 'PAID' as const,
    };
    const operations = new Map<string, PendingMintOperation>([
      [unpaidOperation.id, unpaidOperation],
      [paidOperation.id, paidOperation],
    ]);
    const recordQuoteObservation: Mock<RecordQuoteObservationFn> = mock(async () => undefined);

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getOperationsForQuote: mock(async () => Array.from(operations.values())),
        recordQuoteObservation,
      } as unknown as MintOperationService,
      bus,
      new NullLogger(),
      { watchExistingPendingOnStart: false },
    );

    await watcher.start();
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: unpaidOperation.id,
      operation: unpaidOperation,
    });
    await bus.emit('mint-op:pending', {
      mintUrl,
      operationId: paidOperation.id,
      operation: paidOperation,
    });

    await callbacks[0]!({
      quote: quoteId,
      request: 'lno1test',
      unit: 'sat',
      amount: undefined,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      pubkey: 'pubkey',
      amount_paid: Amount.from(10),
      amount_issued: Amount.zero(),
    });

    expect(recordQuoteObservation).toHaveBeenCalledTimes(1);
    const [observedOperation, state] = recordQuoteObservation.mock.calls[0] ?? [];
    expect(observedOperation?.id).toBe(paidOperation.id);
    expect(state).toBe('PAID');

    await watcher.stop();
  });

  it('does not record BOLT12 paid observations when paid funds are fully issued', async () => {
    const operation = makeBolt12PendingOperation('mint-op-a', Amount.from(10));
    const recordQuoteObservation: Mock<RecordQuoteObservationFn> = mock(async () => undefined);

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getOperationsForQuote: mock(async () => [operation]),
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

    await callbacks[0]!({
      quote: quoteId,
      request: 'lno1test',
      unit: 'sat',
      amount: undefined,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      pubkey: 'pubkey',
      amount_paid: Amount.from(10),
      amount_issued: Amount.from(10),
    });

    expect(recordQuoteObservation).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('clears stale BOLT12 paid observations without downgrading the canonical quote', async () => {
    const operation = {
      ...makeBolt12PendingOperation('mint-op-stale', Amount.from(10)),
      lastObservedRemoteState: 'PAID' as const,
    };
    const recordQuoteObservation: Mock<RecordQuoteObservationFn> = mock(async () => undefined);
    const recordPendingObservation: Mock<RecordPendingObservationFn> = mock(async () => undefined);

    const watcher = new MintOperationWatcherService(
      { subscribe } as unknown as SubscriptionManager,
      { isTrustedMint: mock(async () => true) } as unknown as MintService,
      {
        getOperationsForQuote: mock(async () => [operation]),
        recordQuoteObservation,
        recordPendingObservation,
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

    await callbacks[0]!({
      quote: quoteId,
      request: 'lno1test',
      unit: 'sat',
      amount: undefined,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      pubkey: 'pubkey',
      amount_paid: Amount.from(10),
      amount_issued: Amount.from(10),
    });

    expect(recordQuoteObservation).not.toHaveBeenCalled();
    expect(recordPendingObservation).toHaveBeenCalledTimes(1);
    expect(recordPendingObservation).toHaveBeenCalledWith(
      operation.id,
      'UNPAID',
      expect.any(Number),
    );

    await watcher.stop();
  });
});
