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
});
