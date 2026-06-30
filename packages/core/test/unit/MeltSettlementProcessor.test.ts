import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { MeltQuote } from '../../models/MeltQuote.ts';
import type {
  FinalizedMeltOperation,
  PendingMeltOperation,
  RolledBackMeltOperation,
} from '../../operations/melt/MeltOperation.ts';
import type { MeltOperationService } from '../../operations/melt/MeltOperationService.ts';
import type { MeltQuoteWatcherService } from '../../services/watchers/MeltQuoteWatcherService.ts';
import { MeltSettlementProcessor } from '../../services/watchers/MeltSettlementProcessor.ts';

describe('MeltSettlementProcessor', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'melt-quote-1';

  let bus: EventBus<CoreEvents>;
  let checkPendingOperation: Mock<any>;
  let getPendingOperations: Mock<any>;
  let registerOperationInterest: Mock<any>;
  let removeOperationInterest: Mock<any>;
  let logger: Logger;
  let warn: Mock<any>;
  let processor: MeltSettlementProcessor;

  const makePendingOperation = (
    overrides: Partial<PendingMeltOperation> = {},
  ): PendingMeltOperation => ({
    id: 'melt-op-1',
    mintUrl,
    method: 'bolt11',
    methodData: { invoice: 'lnbc1test' },
    unit: 'sat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: 'pending',
    needsSwap: false,
    amount: Amount.from(10),
    fee_reserve: Amount.from(1),
    quoteId,
    swap_fee: Amount.zero(),
    inputAmount: Amount.from(11),
    inputProofSecrets: ['input-secret'],
    changeOutputData: { keep: [], send: [] },
    ...overrides,
  });

  const makeQuote = (overrides: Partial<MeltQuote<'bolt11'>> = {}): MeltQuote<'bolt11'> => ({
    mintUrl,
    method: 'bolt11',
    quoteId,
    quote: quoteId,
    request: 'lnbc1test',
    amount: Amount.from(10),
    unit: 'sat',
    fee_reserve: Amount.from(1),
    expiry: Math.floor(Date.now() / 1000) + 3600,
    state: 'PENDING',
    payment_preimage: null,
    change: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  const makeFinalizedOperation = (): FinalizedMeltOperation => ({
    ...makePendingOperation(),
    state: 'finalized',
  });

  const makeRolledBackOperation = (): RolledBackMeltOperation => ({
    ...makePendingOperation(),
    state: 'rolled_back',
  });

  const emitPending = (operation = makePendingOperation()) =>
    bus.emit('melt-op:pending', {
      mintUrl: operation.mintUrl,
      operationId: operation.id,
      operation,
    });

  const emitQuoteUpdated = (quote = makeQuote()) =>
    bus.emit('melt-quote:updated', {
      mintUrl: quote.mintUrl,
      method: quote.method,
      quoteId: quote.quoteId,
      quote,
    });

  beforeEach(() => {
    bus = new EventBus<CoreEvents>();
    checkPendingOperation = mock(async () => 'stay_pending');
    getPendingOperations = mock(async () => []);
    registerOperationInterest = mock(async () => {});
    removeOperationInterest = mock(async () => {});
    warn = mock(() => {});
    logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn,
      error: mock(() => {}),
    };
    processor = new MeltSettlementProcessor(
      {
        checkPendingOperation,
        getPendingOperations,
      } as unknown as MeltOperationService,
      bus,
      logger,
      {
        interestRegistrar: {
          registerOperationInterest,
          removeOperationInterest,
        } as unknown as MeltQuoteWatcherService,
      },
    );
  });

  it('registers operation interest when a melt operation enters pending', async () => {
    await processor.start();

    await emitPending();

    expect(registerOperationInterest).toHaveBeenCalledWith({
      operationId: 'melt-op-1',
      mintUrl,
      method: 'bolt11',
      quoteId,
    });

    await emitQuoteUpdated();

    expect(checkPendingOperation).toHaveBeenCalledWith('melt-op-1');
  });

  it('initializes operation interest for existing pending melt operations on startup', async () => {
    const pending = makePendingOperation({ id: 'existing-pending' });
    getPendingOperations.mockResolvedValueOnce([
      pending,
      { ...pending, id: 'existing-executing', state: 'executing' },
    ]);

    await processor.start();

    expect(registerOperationInterest).toHaveBeenCalledTimes(1);
    expect(registerOperationInterest).toHaveBeenCalledWith({
      operationId: 'existing-pending',
      mintUrl,
      method: 'bolt11',
      quoteId,
    });

    await emitQuoteUpdated();

    expect(checkPendingOperation).toHaveBeenCalledWith('existing-pending');
  });

  it('checks only operation ids with exact interest in the updated quote', async () => {
    await processor.start();
    await emitPending(makePendingOperation({ id: 'interested-a', quoteId: 'quote-a' }));
    await emitPending(makePendingOperation({ id: 'interested-b', quoteId: 'quote-b' }));

    await emitQuoteUpdated(makeQuote({ quoteId: 'quote-a', quote: 'quote-a' }));

    expect(checkPendingOperation.mock.calls.map((call) => call[0])).toEqual(['interested-a']);
  });

  it.each(['PAID', 'PENDING', 'UNPAID'] as const)(
    'checks interested operations when the observed quote state is %s',
    async (state) => {
      await processor.start();
      await emitPending();

      await emitQuoteUpdated(makeQuote({ state }));

      expect(checkPendingOperation).toHaveBeenCalledWith('melt-op-1');
    },
  );

  it('does nothing for quote updates without operation interest', async () => {
    await processor.start();

    await emitQuoteUpdated();

    expect(checkPendingOperation).not.toHaveBeenCalled();
  });

  it('suppresses concurrent checks for the same operation', async () => {
    let resolveCheck: ((value: 'stay_pending') => void) | undefined;
    checkPendingOperation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    await processor.start();
    await emitPending();

    const first = emitQuoteUpdated();
    await Promise.resolve();
    await emitQuoteUpdated();

    expect(checkPendingOperation).toHaveBeenCalledTimes(1);

    resolveCheck?.('stay_pending');
    await first;
  });

  it('logs processor failures without retrying until a future notification arrives', async () => {
    checkPendingOperation.mockRejectedValueOnce(new Error('mint unavailable'));
    await processor.start();
    await emitPending();

    await emitQuoteUpdated();
    await Promise.resolve();

    expect(checkPendingOperation).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Failed to settle pending melt operation', {
      operationId: 'melt-op-1',
      mintUrl,
      method: 'bolt11',
      quoteId,
      err: expect.any(Error),
    });

    await emitQuoteUpdated();

    expect(checkPendingOperation).toHaveBeenCalledTimes(2);
  });

  it('removes operation interest when an operation finalizes', async () => {
    await processor.start();
    await emitPending();

    await bus.emit('melt-op:finalized', {
      mintUrl,
      operationId: 'melt-op-1',
      operation: makeFinalizedOperation(),
    });
    await emitQuoteUpdated();

    expect(removeOperationInterest).toHaveBeenCalledWith('melt-op-1');
    expect(checkPendingOperation).not.toHaveBeenCalled();
  });

  it('removes operation interest when an operation rolls back', async () => {
    await processor.start();
    await emitPending();

    await bus.emit('melt-op:rolled-back', {
      mintUrl,
      operationId: 'melt-op-1',
      operation: makeRolledBackOperation(),
    });
    await emitQuoteUpdated();

    expect(removeOperationInterest).toHaveBeenCalledWith('melt-op-1');
    expect(checkPendingOperation).not.toHaveBeenCalled();
  });

  it('reports running state and removes registered interests on stop', async () => {
    expect(processor.isRunning()).toBe(false);

    await processor.start();
    await emitPending();

    expect(processor.isRunning()).toBe(true);

    await processor.stop();

    expect(processor.isRunning()).toBe(false);
    expect(removeOperationInterest).toHaveBeenCalledWith('melt-op-1');

    await emitQuoteUpdated();

    expect(checkPendingOperation).not.toHaveBeenCalled();
  });

  it('waits for in-flight checks before removing interests on stop', async () => {
    let resolveCheck: ((value: 'stay_pending') => void) | undefined;
    checkPendingOperation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    await processor.start();
    await emitPending();

    const notification = emitQuoteUpdated();
    await Promise.resolve();

    const stopped = processor.stop();
    await Promise.resolve();

    expect(removeOperationInterest).not.toHaveBeenCalled();

    resolveCheck?.('stay_pending');
    await notification;
    await stopped;

    expect(removeOperationInterest).toHaveBeenCalledWith('melt-op-1');
    expect(processor.isRunning()).toBe(false);
  });
});
