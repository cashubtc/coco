import { Amount, type Manager } from '@cashu/coco-core';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createHookWrapper, createStrictHookWrapper } from '../../test/testUtils';
import type { SendOperationPrepareInput } from './useSendOperation';
import { useSendOperation } from './useSendOperation';
import type { ReceiveOperationPrepareInput } from './useReceiveOperation';
import { useReceiveOperation } from './useReceiveOperation';
import type { MintOperationPrepareInput } from './useMintOperation';
import { useMintOperation } from './useMintOperation';
import type { MeltOperationPrepareInput } from './useMeltOperation';
import { useMeltOperation } from './useMeltOperation';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function waitForAssertion(assertion: () => void): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }

    await act(async () => {
      await Promise.resolve();
    });
  }

  throw lastError;
}

type SendOps = Manager['ops']['send'];
type SendPrepareResult = Awaited<ReturnType<SendOps['prepare']>>;
type SendExecuteResult = Awaited<ReturnType<SendOps['execute']>>;
type SendOperationRecord = NonNullable<Awaited<ReturnType<SendOps['get']>>>;
type PendingSendOperationRecord = SendExecuteResult['operation'];

type ReceiveOps = Manager['ops']['receive'];
type ReceivePrepareResult = Awaited<ReturnType<ReceiveOps['prepare']>>;
type PreparedReceiveRecord = Extract<ReceivePrepareResult, { state: 'prepared' }>;
type ReceiveExecuteResult = Awaited<ReturnType<ReceiveOps['execute']>>;
type ReceiveOperationRecord = NonNullable<Awaited<ReturnType<ReceiveOps['get']>>>;

type MintOps = Manager['ops']['mint'];
type MintPrepareResult = Awaited<ReturnType<MintOps['prepare']>>;
type MintExecuteResult = Awaited<ReturnType<MintOps['execute']>>;
type MintCheckPaymentResult = Awaited<ReturnType<MintOps['checkPayment']>>;
type MintOperationRecord = NonNullable<Awaited<ReturnType<MintOps['get']>>>;

type MeltOps = Manager['ops']['melt'];
type MeltPrepareResult = Awaited<ReturnType<MeltOps['prepare']>>;
type MeltOperationRecord = NonNullable<Awaited<ReturnType<MeltOps['get']>>>;

const MINT_URL = 'https://mint.example';
const SEND_PREPARE_INPUT: SendOperationPrepareInput = { mintUrl: MINT_URL, amount: 100 };
const RECEIVE_PREPARE_INPUT: ReceiveOperationPrepareInput = { token: 'cashu-token' };
const MINT_PREPARE_INPUT: MintOperationPrepareInput = {
  quote: {
    mintUrl: MINT_URL,
    quoteId: 'mint-quote-1',
    method: 'bolt11',
  },
  amount: 100,
};
const MELT_PREPARE_INPUT: MeltOperationPrepareInput = {
  quote: {
    mintUrl: MINT_URL,
    method: 'bolt11',
    quoteId: 'melt-quote-1',
  },
};

function createEventBusMock() {
  const listeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();

  const on = vi.fn((event: string, handler: (payload: unknown) => void | Promise<void>) => {
    const handlers = listeners.get(event) ?? new Set();
    handlers.add(handler);
    listeners.set(event, handlers);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        listeners.delete(event);
      }
    };
  });

  const emit = async (event: string, payload: unknown): Promise<void> => {
    const handlers = Array.from(listeners.get(event) ?? []);
    for (const handler of handlers) {
      await handler(payload);
    }
  };

  return { on, emit };
}

function createSendManagerMock() {
  const send = {
    prepare: vi.fn(),
    execute: vi.fn(),
    get: vi.fn(),
    listPrepared: vi.fn(),
    listInFlight: vi.fn(),
    refresh: vi.fn(),
    cancel: vi.fn(),
    reclaim: vi.fn(),
    finalize: vi.fn(),
  };
  const { on, emit } = createEventBusMock();

  return {
    manager: { ops: { send }, on } as unknown as Manager,
    send,
    emit,
  };
}

function createReceiveManagerMock() {
  const receive = {
    prepare: vi.fn(),
    execute: vi.fn(),
    get: vi.fn(),
    listPrepared: vi.fn(),
    listDeferred: vi.fn(),
    redeemDeferred: vi.fn(),
    listInFlight: vi.fn(),
    refresh: vi.fn(),
    cancel: vi.fn(),
  };
  const { on, emit } = createEventBusMock();

  return {
    manager: { ops: { receive }, on } as unknown as Manager,
    receive,
    emit,
  };
}

function createReceiveManagerWithBoundOnMock() {
  const receive = {
    prepare: vi.fn(),
    execute: vi.fn(),
    get: vi.fn(),
    listPrepared: vi.fn(),
    listInFlight: vi.fn(),
    refresh: vi.fn(),
    cancel: vi.fn(),
  };
  const eventBus = createEventBusMock();
  type EventBusMock = ReturnType<typeof createEventBusMock>;
  const manager = {
    ops: { receive },
    eventBus,
    on(
      this: { eventBus: EventBusMock },
      event: string,
      handler: (payload: unknown) => void | Promise<void>,
    ) {
      return this.eventBus.on(event, handler);
    },
  } as unknown as Manager & { eventBus: EventBusMock };

  return {
    manager,
    receive,
    emit: eventBus.emit,
  };
}

function createMintManagerMock() {
  const mint = {
    prepare: vi.fn(),
    execute: vi.fn(),
    get: vi.fn(),
    listByQuote: vi.fn(),
    listPending: vi.fn(),
    listInFlight: vi.fn(),
    checkPayment: vi.fn(),
    refresh: vi.fn(),
    finalize: vi.fn(),
  };
  const { on, emit } = createEventBusMock();

  return {
    manager: { ops: { mint }, on } as unknown as Manager,
    mint,
    emit,
  };
}

function createMeltManagerMock() {
  const melt = {
    prepare: vi.fn(),
    execute: vi.fn(),
    get: vi.fn(),
    getByQuote: vi.fn(),
    listByQuote: vi.fn(),
    listPrepared: vi.fn(),
    listInFlight: vi.fn(),
    refresh: vi.fn(),
    cancel: vi.fn(),
    reclaim: vi.fn(),
    finalize: vi.fn(),
  };
  const { on, emit } = createEventBusMock();

  return {
    manager: { ops: { melt }, on } as unknown as Manager,
    melt,
    emit,
  };
}

function createPreparedSendOperation(
  overrides: Partial<SendPrepareResult> = {},
): SendPrepareResult {
  return {
    id: 'send-op-1',
    state: 'prepared',
    mintUrl: MINT_URL,
    amount: Amount.from(100),
    unit: 'sat',
    method: 'default',
    methodData: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    needsSwap: false,
    fee: Amount.zero(),
    inputAmount: Amount.from(100),
    inputProofSecrets: ['send-proof-1'],
    ...overrides,
  };
}

function createPendingSendOperation(
  overrides: Partial<PendingSendOperationRecord> = {},
): PendingSendOperationRecord {
  return {
    ...createPreparedSendOperation(),
    state: 'pending',
    updatedAt: 1_700_000_001_000,
    token: {} as SendExecuteResult['token'],
    ...overrides,
  };
}

function createFinalizedSendOperation(
  overrides: Partial<SendOperationRecord> = {},
): SendOperationRecord {
  return {
    ...createPendingSendOperation(),
    state: 'finalized',
    updatedAt: 1_700_000_002_000,
    ...overrides,
  } as SendOperationRecord;
}

function createSendExecuteResult(overrides: Partial<SendExecuteResult> = {}): SendExecuteResult {
  return {
    operation: createPendingSendOperation(),
    token: {} as SendExecuteResult['token'],
    ...overrides,
  };
}

function createPreparedReceiveOperation(
  overrides: Partial<PreparedReceiveRecord> = {},
): PreparedReceiveRecord {
  return {
    id: 'receive-op-1',
    state: 'prepared',
    mintUrl: MINT_URL,
    unit: 'sat',
    amount: Amount.from(100),
    inputProofs: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    fee: Amount.zero(),
    outputData: {} as PreparedReceiveRecord['outputData'],
    ...overrides,
  };
}

function createInitReceiveOperation(
  overrides: Partial<ReceiveOperationRecord> = {},
): ReceiveOperationRecord {
  return {
    id: 'receive-op-init',
    state: 'init',
    mintUrl: MINT_URL,
    unit: 'sat',
    amount: Amount.from(100),
    inputProofs: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  } as ReceiveOperationRecord;
}

function createFinalizedReceiveOperation(
  overrides: Partial<ReceiveExecuteResult> = {},
): ReceiveExecuteResult {
  return {
    ...createPreparedReceiveOperation(),
    state: 'finalized',
    updatedAt: 1_700_000_001_000,
    ...overrides,
  };
}

function createRolledBackReceiveOperation(
  overrides: Partial<ReceiveOperationRecord> = {},
): ReceiveOperationRecord {
  return {
    ...createPreparedReceiveOperation(),
    state: 'rolled_back',
    updatedAt: 1_700_000_001_000,
    ...overrides,
  } as ReceiveOperationRecord;
}

function createPendingMintOperation(overrides: Partial<MintPrepareResult> = {}): MintPrepareResult {
  return {
    id: 'mint-op-1',
    state: 'pending',
    mintUrl: MINT_URL,
    method: 'bolt11',
    methodData: {},
    amount: Amount.from(100),
    unit: 'sat',
    quoteId: 'mint-quote-1',
    request: 'lnbc1mintrequest',
    expiry: 1_700_000_100_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    outputData: {} as MintPrepareResult['outputData'],
    ...overrides,
  };
}

function createFinalizedMintOperation(
  overrides: Partial<MintExecuteResult> = {},
): MintExecuteResult {
  return {
    ...createPendingMintOperation(),
    state: 'finalized',
    updatedAt: 1_700_000_020_000,
    ...overrides,
  } as MintExecuteResult;
}

function createFailedMintOperation(
  overrides: Partial<MintOperationRecord> = {},
): MintOperationRecord {
  return {
    ...createPendingMintOperation(),
    state: 'failed',
    updatedAt: 1_700_000_020_000,
    error: 'Quote expired before issuance',
    terminalFailure: {
      reason: 'Quote expired before issuance',
      code: 'quote_expired',
      retryable: false,
      observedAt: 1_700_000_020_000,
    },
    ...overrides,
  } as MintOperationRecord;
}

function createMintCheckPaymentResult(
  overrides: Partial<MintCheckPaymentResult> = {},
): MintCheckPaymentResult {
  return {
    observedRemoteState: 'PAID',
    observedRemoteStateAt: 1_700_000_010_000,
    category: 'ready',
    ...overrides,
  };
}

function createMintOperation(overrides: Partial<MintOperationRecord> = {}): MintOperationRecord {
  return {
    ...createPendingMintOperation(),
    updatedAt: 1_700_000_010_000,
    ...overrides,
  } as MintOperationRecord;
}

function createPreparedMeltOperation(
  overrides: Partial<MeltPrepareResult> = {},
): MeltPrepareResult {
  return {
    id: 'melt-op-1',
    state: 'prepared',
    mintUrl: MINT_URL,
    method: 'bolt11',
    methodData: { invoice: 'lnbc1meltinvoice' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    needsSwap: false,
    amount: Amount.from(100),
    unit: 'sat',
    fee_reserve: Amount.from(1),
    quoteId: 'melt-quote-1',
    swap_fee: Amount.zero(),
    inputAmount: Amount.from(101),
    inputProofSecrets: ['melt-proof-1'],
    changeOutputData: {} as MeltPrepareResult['changeOutputData'],
    ...overrides,
  };
}

function createPendingMeltOperation(
  overrides: Partial<MeltOperationRecord> = {},
): MeltOperationRecord {
  return {
    ...createPreparedMeltOperation(),
    state: 'pending',
    updatedAt: 1_700_000_001_000,
    ...overrides,
  } as MeltOperationRecord;
}

function createFinalizedMeltOperation(
  overrides: Partial<MeltOperationRecord> = {},
): MeltOperationRecord {
  return {
    ...createPendingMeltOperation(),
    state: 'finalized',
    updatedAt: 1_700_000_002_000,
    ...overrides,
  } as MeltOperationRecord;
}

function createRolledBackMeltOperation(
  overrides: Partial<MeltOperationRecord> = {},
): MeltOperationRecord {
  return {
    ...createPreparedMeltOperation(),
    state: 'rolled_back',
    updatedAt: 1_700_000_002_000,
    ...overrides,
  } as MeltOperationRecord;
}

describe('useSendOperation', () => {
  it('passes object-form custom-unit amount inputs through to send prepare', async () => {
    const { manager, send } = createSendManagerMock();
    const prepared = createPreparedSendOperation({
      amount: Amount.from(25),
      unit: 'usd',
    });
    const input: SendOperationPrepareInput = {
      mintUrl: MINT_URL,
      amount: { amount: Amount.from(25), unit: 'USD' },
    };

    send.prepare.mockResolvedValue(prepared);

    const { result } = renderHook(() => useSendOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await result.current.prepare(input);
    });

    expect(send.prepare).toHaveBeenCalledWith(input);
    expect(result.current.currentOperation).toEqual(prepared);
  });

  it('prepares, executes the bound operation by default, and synchronizes after finalize', async () => {
    const { manager, send } = createSendManagerMock();
    const prepared = createPreparedSendOperation();
    const executeResult = createSendExecuteResult({
      operation: createPendingSendOperation({ id: prepared.id }),
    });
    const finalized = createFinalizedSendOperation({ id: prepared.id });

    send.prepare.mockResolvedValue(prepared);
    send.execute.mockResolvedValue(executeResult);
    send.finalize.mockResolvedValue(undefined);
    send.get.mockResolvedValue(finalized);

    const { result } = renderHook(() => useSendOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await result.current.prepare(SEND_PREPARE_INPUT);
    });

    expect(result.current.currentOperation).toEqual(prepared);

    await act(async () => {
      await result.current.execute();
    });

    expect(send.execute).toHaveBeenCalledWith(prepared.id);
    expect(result.current.currentOperation).toEqual(executeResult.operation);
    expect(result.current.executeResult).toEqual(executeResult);

    await act(async () => {
      await result.current.finalize();
    });

    expect(send.finalize).toHaveBeenCalledWith(prepared.id);
    expect(result.current.currentOperation).toEqual(finalized);
    expect(result.current.executeResult).toEqual(executeResult);
  });

  it('supports initial operation-id binding and reset clears only local state', async () => {
    const { manager, send } = createSendManagerMock();
    const loaded = createPreparedSendOperation({ id: 'send-op-load' });
    const executeResult = createSendExecuteResult({
      operation: createPendingSendOperation({ id: loaded.id }),
    });

    send.get.mockResolvedValue(loaded);
    send.execute.mockResolvedValue(executeResult);
    send.listPrepared.mockResolvedValue([loaded]);
    send.listInFlight.mockResolvedValue([executeResult.operation]);

    const { result } = renderHook(() => useSendOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(loaded);
    });

    const preparedList = await result.current.listPrepared();
    const inFlightList = await result.current.listInFlight();

    expect(preparedList).toEqual([loaded]);
    expect(inFlightList).toEqual([executeResult.operation]);
    expect(result.current.currentOperation).toEqual(loaded);

    await act(async () => {
      await result.current.execute();
    });

    expect(send.execute).toHaveBeenCalledWith(loaded.id);
    expect(result.current.currentOperation).toEqual(executeResult.operation);

    act(() => {
      result.current.reset();
    });

    expect(result.current.currentOperation).toBeNull();
    expect(result.current.executeResult).toBeNull();
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('reacts to background events for the bound send operation id and ignores others', async () => {
    const { manager, send, emit } = createSendManagerMock();
    const loaded = createPreparedSendOperation({ id: 'send-op-events' });
    const finalized = createFinalizedSendOperation({ id: loaded.id });

    send.get.mockResolvedValueOnce(loaded);

    const { result } = renderHook(() => useSendOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(loaded);
    });

    await emit('send:finalized', {
      mintUrl: loaded.mintUrl,
      operationId: loaded.id,
      operation: finalized,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(finalized);
    });

    await emit('send:finalized', {
      mintUrl: loaded.mintUrl,
      operationId: 'send-op-other',
      operation: createFinalizedSendOperation({ id: 'send-op-other' }),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.currentOperation).toEqual(finalized);
  });

  it('rejects prepare when the hook is already bound to a send operation', async () => {
    const { manager, send } = createSendManagerMock();
    const loaded = createPreparedSendOperation({ id: 'send-op-bound' });

    const { result } = renderHook(() => useSendOperation(loaded), {
      wrapper: createHookWrapper(manager),
    });

    await expect(result.current.prepare(SEND_PREPARE_INPUT)).rejects.toThrow(
      `Cannot call prepare while this hook is bound to operation ${loaded.id}. Remount the hook with a new React key or call reset() first.`,
    );
    expect(send.prepare).not.toHaveBeenCalled();
    expect(result.current.currentOperation).toEqual(loaded);
  });

  it('keeps the newer send operation when hydration resolves with an older snapshot', async () => {
    const { manager, send, emit } = createSendManagerMock();
    const loaded = createPreparedSendOperation({ id: 'send-op-hydrate', updatedAt: 10 });
    const finalized = createFinalizedSendOperation({ id: loaded.id, updatedAt: 20 });
    const deferredLoad = createDeferred<SendOperationRecord | null>();

    send.get.mockReturnValue(deferredLoad.promise);

    const { result } = renderHook(() => useSendOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await Promise.resolve();
    });

    await emit('send:finalized', {
      mintUrl: loaded.mintUrl,
      operationId: loaded.id,
      operation: finalized,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(finalized);
    });

    deferredLoad.resolve(loaded);
    await act(async () => {
      await deferredLoad.promise;
    });

    expect(result.current.currentOperation).toEqual(finalized);
    expect(send.get).toHaveBeenCalledTimes(1);
  });

  it('accepts same-id send updates when updatedAt is equal', async () => {
    const { manager, send, emit } = createSendManagerMock();
    const loaded = createPreparedSendOperation({ id: 'send-op-equal', updatedAt: 10 });
    const finalized = createFinalizedSendOperation({ id: loaded.id, updatedAt: loaded.updatedAt });

    send.get.mockResolvedValueOnce(loaded);

    const { result } = renderHook(() => useSendOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(loaded);
    });

    await emit('send:finalized', {
      mintUrl: loaded.mintUrl,
      operationId: loaded.id,
      operation: finalized,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.currentOperation).toEqual(finalized);
  });

  it('rejects concurrent stateful actions immediately', async () => {
    const { manager, send } = createSendManagerMock();
    const pendingPrepare = createDeferred<SendPrepareResult>();

    send.prepare.mockReturnValue(pendingPrepare.promise);

    const { result } = renderHook(() => useSendOperation(), {
      wrapper: createHookWrapper(manager),
    });

    let firstPreparePromise!: Promise<SendPrepareResult>;

    act(() => {
      firstPreparePromise = result.current.prepare(SEND_PREPARE_INPUT);
    });

    await expect(result.current.prepare(SEND_PREPARE_INPUT)).rejects.toThrow(
      'Operation already in progress',
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe('loading');
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isError).toBe(false);

    await act(async () => {
      pendingPrepare.resolve(createPreparedSendOperation({ id: 'send-op-2' }));
      await firstPreparePromise;
    });

    expect(result.current.status).toBe('success');
  });

  it('updates operation state in StrictMode during prepare and execute', async () => {
    const { manager, send } = createSendManagerMock();
    const prepared = createPreparedSendOperation();
    const executeResult = createSendExecuteResult({
      operation: createPendingSendOperation({ id: prepared.id }),
    });

    send.prepare.mockResolvedValue(prepared);
    send.execute.mockResolvedValue(executeResult);

    const { result } = renderHook(() => useSendOperation(), {
      wrapper: createStrictHookWrapper(manager),
    });

    await act(async () => {
      await result.current.prepare(SEND_PREPARE_INPUT);
    });

    expect(result.current.currentOperation).toEqual(prepared);
    expect(result.current.status).toBe('success');

    await act(async () => {
      await result.current.execute();
    });

    expect(send.execute).toHaveBeenCalledWith(prepared.id);
    expect(result.current.currentOperation).toEqual(executeResult.operation);
    expect(result.current.executeResult).toEqual(executeResult);
    expect(result.current.status).toBe('success');
  });

  it('reports loading for actions started from a mount-time layout effect', async () => {
    const { manager, send } = createSendManagerMock();
    const pendingPrepare = createDeferred<SendPrepareResult>();
    const prepared = createPreparedSendOperation();

    send.prepare.mockReturnValue(pendingPrepare.promise);

    const { result } = renderHook(
      () => {
        const operation = useSendOperation();

        useLayoutEffect(() => {
          void operation.prepare(SEND_PREPARE_INPUT);
        }, [operation.prepare]);

        return operation;
      },
      {
        wrapper: createHookWrapper(manager),
      },
    );

    await waitForAssertion(() => {
      expect(result.current.status).toBe('loading');
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      pendingPrepare.resolve(prepared);
      await pendingPrepare.promise;
    });

    expect(result.current.currentOperation).toEqual(prepared);
    expect(result.current.status).toBe('success');
  });

  it('reports loading for actions started from a mount-time layout effect in StrictMode', async () => {
    const { manager, send } = createSendManagerMock();
    const pendingPrepare = createDeferred<SendPrepareResult>();
    const prepared = createPreparedSendOperation();

    send.prepare.mockReturnValue(pendingPrepare.promise);

    const { result } = renderHook(
      () => {
        const operation = useSendOperation();

        useLayoutEffect(() => {
          void operation.prepare(SEND_PREPARE_INPUT);
        }, [operation.prepare]);

        return operation;
      },
      {
        wrapper: createStrictHookWrapper(manager),
      },
    );

    await waitForAssertion(() => {
      expect(result.current.status).toBe('loading');
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      pendingPrepare.resolve(prepared);
      await pendingPrepare.promise;
    });

    expect(result.current.currentOperation).toEqual(prepared);
    expect(result.current.status).toBe('success');
  });
});

describe('useReceiveOperation', () => {
  it('prepares and executes the bound receive operation by default', async () => {
    const { manager, receive } = createReceiveManagerMock();
    const prepared = createPreparedReceiveOperation();
    const finalized = createFinalizedReceiveOperation({ id: prepared.id });

    receive.prepare.mockResolvedValue(prepared);
    receive.execute.mockResolvedValue(finalized);

    const { result } = renderHook(() => useReceiveOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await result.current.prepare(RECEIVE_PREPARE_INPUT);
    });

    expect(result.current.currentOperation).toEqual(prepared);

    await act(async () => {
      await result.current.execute();
    });

    expect(receive.execute).toHaveBeenCalledWith(prepared.id);
    expect(result.current.currentOperation).toEqual(finalized);
    expect(result.current.executeResult).toEqual(finalized);
  });

  it('binds a deferred prepare result and passes deferred list and redemption through', async () => {
    const { manager, receive } = createReceiveManagerMock();
    const deferred = {
      ...createInitReceiveOperation({ id: 'receive-op-deferred' }),
      state: 'deferred',
      deferredReason: 'dust',
    } as ReceiveOperationRecord;

    receive.prepare.mockResolvedValue(deferred);
    receive.listDeferred.mockResolvedValue([deferred]);
    receive.redeemDeferred.mockResolvedValue(undefined);

    const { result } = renderHook(() => useReceiveOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await result.current.prepare(RECEIVE_PREPARE_INPUT);
    });

    expect(result.current.currentOperation).toEqual(deferred);

    await act(async () => {
      expect(await result.current.listDeferred()).toEqual([deferred]);
      await result.current.redeemDeferred({ mintUrl: MINT_URL });
    });

    expect(receive.listDeferred).toHaveBeenCalled();
    expect(receive.redeemDeferred).toHaveBeenCalledWith({ mintUrl: MINT_URL });
  });

  it('accepts an initial operation-id binding, synchronizes after cancel, and surfaces errors after reset', async () => {
    const { manager, receive } = createReceiveManagerMock();
    const loaded = createPreparedReceiveOperation({ id: 'receive-op-load' });
    const rolledBack = createRolledBackReceiveOperation({ id: loaded.id });

    receive.get.mockResolvedValueOnce(loaded).mockResolvedValueOnce(rolledBack);
    receive.cancel.mockResolvedValue(undefined);

    const { result } = renderHook(() => useReceiveOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(loaded);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(receive.cancel).toHaveBeenCalledWith(loaded.id);
    expect(result.current.currentOperation).toEqual(rolledBack);

    await expect(result.current.prepare(RECEIVE_PREPARE_INPUT)).rejects.toThrow(
      `Cannot call prepare while this hook is bound to operation ${loaded.id}. Remount the hook with a new React key or call reset() first.`,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe('success');
    expect(result.current.error).toBeNull();

    act(() => {
      result.current.reset();
    });

    receive.prepare.mockRejectedValueOnce(new Error('Invalid token'));

    await expect(result.current.prepare(RECEIVE_PREPARE_INPUT)).rejects.toThrow('Invalid token');
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('Invalid token');
  });

  it('treats init cancel as success when the operation is deleted after rollback', async () => {
    const { manager, receive } = createReceiveManagerMock();
    const loaded = createInitReceiveOperation({ id: 'receive-op-init' });

    receive.cancel.mockResolvedValue(undefined);
    receive.get.mockResolvedValue(null);

    const { result } = renderHook(() => useReceiveOperation(loaded), {
      wrapper: createHookWrapper(manager),
    });

    expect(result.current.currentOperation).toEqual(loaded);

    await act(async () => {
      await result.current.cancel();
    });

    expect(receive.cancel).toHaveBeenCalledWith(loaded.id);
    expect(receive.get).toHaveBeenCalledWith(loaded.id);
    expect(result.current.currentOperation).toBeNull();
    expect(result.current.executeResult).toBeNull();
    expect(result.current.status).toBe('success');
    expect(result.current.error).toBeNull();
  });

  it('reacts to background events for the bound receive operation id and ignores others', async () => {
    const { manager, receive, emit } = createReceiveManagerMock();
    const loaded = createPreparedReceiveOperation({ id: 'receive-op-events' });
    const finalized = createFinalizedReceiveOperation({ id: loaded.id });

    receive.get.mockResolvedValueOnce(loaded);

    const { result } = renderHook(() => useReceiveOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(loaded);
    });

    await emit('receive-op:finalized', {
      mintUrl: loaded.mintUrl,
      operationId: loaded.id,
      operation: finalized,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(finalized);
    });

    await emit('receive-op:finalized', {
      mintUrl: loaded.mintUrl,
      operationId: 'receive-op-other',
      operation: createFinalizedReceiveOperation({ id: 'receive-op-other' }),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.currentOperation).toEqual(finalized);
  });

  it('subscribes to receive events without detaching manager.on', async () => {
    const { manager, receive, emit } = createReceiveManagerWithBoundOnMock();
    const loaded = createPreparedReceiveOperation({ id: 'receive-op-bound-on' });
    const finalized = createFinalizedReceiveOperation({ id: loaded.id });

    receive.get.mockResolvedValueOnce(loaded);

    const { result } = renderHook(() => useReceiveOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(loaded);
    });

    await emit('receive-op:finalized', {
      mintUrl: loaded.mintUrl,
      operationId: loaded.id,
      operation: finalized,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(finalized);
    });
  });

  it('rejects prepare when the hook is already bound to a receive operation', async () => {
    const { manager, receive } = createReceiveManagerMock();
    const loaded = createPreparedReceiveOperation({ id: 'receive-op-bound' });

    const { result } = renderHook(() => useReceiveOperation(loaded), {
      wrapper: createHookWrapper(manager),
    });

    await expect(result.current.prepare(RECEIVE_PREPARE_INPUT)).rejects.toThrow(
      `Cannot call prepare while this hook is bound to operation ${loaded.id}. Remount the hook with a new React key or call reset() first.`,
    );
    expect(receive.prepare).not.toHaveBeenCalled();
    expect(result.current.currentOperation).toEqual(loaded);
  });

  it('keeps the newer receive operation when hydration resolves with an older snapshot', async () => {
    const { manager, receive, emit } = createReceiveManagerMock();
    const loaded = createPreparedReceiveOperation({ id: 'receive-op-hydrate', updatedAt: 10 });
    const finalized = createFinalizedReceiveOperation({ id: loaded.id, updatedAt: 20 });
    const deferredLoad = createDeferred<ReceiveOperationRecord | null>();

    receive.get.mockReturnValue(deferredLoad.promise);

    const { result } = renderHook(() => useReceiveOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await Promise.resolve();
    });

    await emit('receive-op:finalized', {
      mintUrl: loaded.mintUrl,
      operationId: loaded.id,
      operation: finalized,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(finalized);
    });

    deferredLoad.resolve(loaded);
    await act(async () => {
      await deferredLoad.promise;
    });

    expect(result.current.currentOperation).toEqual(finalized);
    expect(receive.get).toHaveBeenCalledTimes(1);
  });
});

describe('useMintOperation', () => {
  it('passes quote-id prepare inputs through to mint prepare', async () => {
    const { manager, mint } = createMintManagerMock();
    const pending = createPendingMintOperation({
      amount: Amount.from(50),
      unit: 'usd',
    });
    const input: MintOperationPrepareInput = {
      quote: {
        mintUrl: MINT_URL,
        quoteId: 'mint-quote-usd',
        method: 'bolt11',
      },
      amount: 50,
    };

    mint.prepare.mockResolvedValue(pending);

    const { result } = renderHook(() => useMintOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await result.current.prepare(input);
    });

    expect(mint.prepare).toHaveBeenCalledWith(input);
    expect(result.current.currentOperation).toEqual(pending);
  });

  it('passes BOLT12 mint inputs and quote list helpers through without rebinding', async () => {
    const { manager, mint } = createMintManagerMock();
    const prepared = createPendingMintOperation({
      method: 'bolt12',
      methodData: {},
      quoteId: 'shared-mint-quote',
      request: 'lno1mintoffer',
    });

    const input: MintOperationPrepareInput = {
      quote: {
        mintUrl: MINT_URL,
        method: 'bolt12',
        quoteId: prepared.quoteId,
      },
      amount: 100,
    };

    mint.prepare.mockResolvedValue(prepared);
    mint.listByQuote.mockResolvedValue([prepared]);

    const { result } = renderHook(() => useMintOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await result.current.prepare(input);
    });

    const listByQuote = await result.current.listByQuote({
      mintUrl: MINT_URL,
      quoteId: prepared.quoteId,
    });

    expect(mint.prepare).toHaveBeenCalledWith(input);
    expect(mint.listByQuote).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      quoteId: prepared.quoteId,
    });
    expect(listByQuote).toEqual([prepared]);
    expect(result.current.currentOperation).toEqual(prepared);
  });

  it('binds newly prepared mint operations when starting unbound', async () => {
    const { manager, mint } = createMintManagerMock();
    const pending = createPendingMintOperation();

    mint.prepare.mockResolvedValue(pending);

    const { result: prepareResult } = renderHook(() => useMintOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await prepareResult.current.prepare(MINT_PREPARE_INPUT);
    });

    expect(prepareResult.current.currentOperation).toEqual(pending);
  });

  it('accepts an initial operation-id binding and synchronizes after checkPayment and execute', async () => {
    const { manager, mint } = createMintManagerMock();
    const pending = createPendingMintOperation();
    const refreshed = createMintOperation({ id: pending.id, updatedAt: 1_700_000_010_000 });
    const finalized = createFinalizedMintOperation({ id: pending.id });
    const checkPaymentResult = createMintCheckPaymentResult();

    mint.get.mockResolvedValueOnce(pending).mockResolvedValueOnce(refreshed);
    mint.checkPayment.mockResolvedValue(checkPaymentResult);
    mint.execute.mockResolvedValue(finalized);

    const { result } = renderHook(() => useMintOperation(pending.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(pending);
    });

    let observedPayment: MintCheckPaymentResult | undefined;
    await act(async () => {
      observedPayment = await result.current.checkPayment();
    });

    expect(observedPayment).toEqual(checkPaymentResult);
    expect(result.current.currentOperation).toEqual(refreshed);

    await act(async () => {
      await result.current.execute();
    });

    expect(mint.execute).toHaveBeenCalledWith(pending.id);
    expect(result.current.currentOperation).toEqual(finalized);
    expect(result.current.executeResult).toEqual(finalized);
  });

  it('surfaces an error when an initial operation-id binding is missing', async () => {
    const { manager, mint } = createMintManagerMock();

    mint.get.mockResolvedValue(null);

    const { result } = renderHook(() => useMintOperation('missing-mint-op'), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.status).toBe('error');
      expect(result.current.error?.message).toContain('Operation missing-mint-op not found');
    });
  });

  it('can prepare after a missing initial operation-id binding', async () => {
    const { manager, mint } = createMintManagerMock();
    const pending = createPendingMintOperation({ id: 'mint-op-recovered' });

    mint.get.mockResolvedValue(null);
    mint.prepare.mockResolvedValue(pending);

    const { result } = renderHook(() => useMintOperation('missing-mint-op'), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.status).toBe('error');
    });

    await act(async () => {
      await result.current.prepare(MINT_PREPARE_INPUT);
    });

    expect(result.current.currentOperation).toEqual(pending);
  });

  it('rejects prepare when the hook is already bound to a mint operation', async () => {
    const { manager, mint } = createMintManagerMock();
    const loaded = createPendingMintOperation({ id: 'mint-op-bound' });

    const { result } = renderHook(() => useMintOperation(loaded), {
      wrapper: createHookWrapper(manager),
    });

    await expect(result.current.prepare(MINT_PREPARE_INPUT)).rejects.toThrow(
      `Cannot call prepare while this hook is bound to operation ${loaded.id}. Remount the hook with a new React key or call reset() first.`,
    );
    expect(mint.prepare).not.toHaveBeenCalled();
    expect(result.current.currentOperation).toEqual(loaded);
  });

  it('keeps the newer mint operation when hydration resolves with an older snapshot', async () => {
    const { manager, mint, emit } = createMintManagerMock();
    const pending = createPendingMintOperation({ id: 'mint-op-hydrate', updatedAt: 10 });
    const executing = createMintOperation({
      id: pending.id,
      state: 'executing',
      updatedAt: 20,
    });
    const deferredLoad = createDeferred<MintOperationRecord | null>();

    mint.get.mockReturnValue(deferredLoad.promise);

    const { result } = renderHook(() => useMintOperation(pending.id), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await Promise.resolve();
    });

    await emit('mint-op:executing', {
      mintUrl: pending.mintUrl,
      operationId: pending.id,
      operation: executing,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(executing);
    });

    deferredLoad.resolve(pending);
    await act(async () => {
      await deferredLoad.promise;
    });

    expect(result.current.currentOperation).toEqual(executing);
    expect(mint.get).toHaveBeenCalledTimes(1);
  });

  it('reacts to background pending, executing, and finalized events for the bound operation id', async () => {
    const { manager, mint, emit } = createMintManagerMock();
    const pending = createPendingMintOperation();
    const observed = createMintOperation({ id: pending.id, updatedAt: 1_700_000_010_000 });
    const executing = createMintOperation({
      id: pending.id,
      state: 'executing',
      updatedAt: 1_700_000_015_000,
    });
    const finalized = createFinalizedMintOperation({ id: pending.id });

    mint.get.mockResolvedValueOnce(pending);

    const { result } = renderHook(() => useMintOperation(pending.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(pending);
    });

    await emit('mint-op:pending', {
      mintUrl: pending.mintUrl,
      operationId: pending.id,
      operation: observed,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(observed);
    });

    await emit('mint-op:executing', {
      mintUrl: pending.mintUrl,
      operationId: pending.id,
      operation: executing,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(executing);
    });

    await emit('mint-op:finalized', {
      mintUrl: pending.mintUrl,
      operationId: pending.id,
      operation: finalized,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(finalized);
    });
    expect(mint.get).toHaveBeenCalledTimes(1);
  });

  it('reacts to background failed events for the bound mint operation id', async () => {
    const { manager, mint, emit } = createMintManagerMock();
    const pending = createPendingMintOperation();
    const failed = createFailedMintOperation({ id: pending.id });

    mint.get.mockResolvedValueOnce(pending);

    const { result } = renderHook(() => useMintOperation(pending.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(pending);
    });

    await emit('mint-op:failed', {
      mintUrl: pending.mintUrl,
      operationId: pending.id,
      operation: failed,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(failed);
    });
    expect(mint.get).toHaveBeenCalledTimes(1);
  });

  it('ignores background events for other operation ids', async () => {
    const { manager, mint, emit } = createMintManagerMock();
    const pending = createPendingMintOperation();

    mint.get.mockResolvedValueOnce(pending);

    const { result } = renderHook(() => useMintOperation(pending.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(pending);
    });

    await emit('mint-op:finalized', {
      mintUrl: pending.mintUrl,
      operationId: 'mint-op-other',
      operation: createFinalizedMintOperation({ id: 'mint-op-other' }),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mint.get).toHaveBeenCalledTimes(1);
    expect(result.current.currentOperation).toEqual(pending);
  });
});

describe('useMeltOperation', () => {
  it('passes custom-unit melt quote inputs through to melt prepare', async () => {
    const { manager, melt } = createMeltManagerMock();
    const prepared = createPreparedMeltOperation({ unit: 'usd' });
    melt.prepare.mockResolvedValue(prepared);

    const { result } = renderHook(() => useMeltOperation(), {
      wrapper: createHookWrapper(manager),
    });

    const quote = {
      mintUrl: MINT_URL,
      quoteId: 'melt-quote-1',
      quote: 'melt-quote-1',
      request: 'lnbc1test',
      unit: 'USD',
      method: 'bolt11',
      amount: Amount.from(100),
      fee_reserve: Amount.from(1),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'UNPAID',
      payment_preimage: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as const;
    const input: MeltOperationPrepareInput = { quote };

    await act(async () => {
      await result.current.prepare(input);
    });

    expect(melt.prepare).toHaveBeenCalledWith(input);
    expect(result.current.currentOperation).toEqual(prepared);
  });

  it('passes BOLT12 melt inputs and quote lookup helpers through without rebinding', async () => {
    const { manager, melt } = createMeltManagerMock();
    const prepared = createPreparedMeltOperation({
      method: 'bolt12',
      methodData: { offer: 'lno1amountlessoffer' },
      quoteId: 'shared-melt-quote',
    });
    const latest = createPreparedMeltOperation({
      id: 'melt-op-latest',
      method: 'bolt12',
      methodData: { offer: 'lno1amountlessoffer' },
      quoteId: prepared.quoteId,
      updatedAt: prepared.updatedAt + 1,
    });

    const input: MeltOperationPrepareInput = {
      quote: {
        mintUrl: MINT_URL,
        method: 'bolt12',
        quoteId: prepared.quoteId,
      },
    };

    melt.prepare.mockResolvedValue(prepared);
    melt.getByQuote.mockResolvedValue(latest);
    melt.listByQuote.mockResolvedValue([prepared, latest]);

    const { result } = renderHook(() => useMeltOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await result.current.prepare(input);
    });

    const byQuote = await result.current.getByQuote({
      mintUrl: MINT_URL,
      quoteId: prepared.quoteId,
    });
    const listByQuote = await result.current.listByQuote({
      mintUrl: MINT_URL,
      quoteId: prepared.quoteId,
    });

    expect(melt.prepare).toHaveBeenCalledWith(input);
    expect(melt.getByQuote).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      quoteId: prepared.quoteId,
    });
    expect(melt.listByQuote).toHaveBeenCalledWith({
      mintUrl: MINT_URL,
      quoteId: prepared.quoteId,
    });
    expect(byQuote).toEqual(latest);
    expect(listByQuote).toEqual([prepared, latest]);
    expect(result.current.currentOperation).toEqual(prepared);
  });

  it('prepares, executes the bound operation by default, and synchronizes after finalize', async () => {
    const { manager, melt } = createMeltManagerMock();
    const prepared = createPreparedMeltOperation();
    const executeResult = createPendingMeltOperation({ id: prepared.id });
    const finalized = createFinalizedMeltOperation({ id: prepared.id });

    melt.prepare.mockResolvedValue(prepared);
    melt.execute.mockResolvedValue(executeResult);
    melt.finalize.mockResolvedValue(undefined);
    melt.get.mockResolvedValue(finalized);

    const { result } = renderHook(() => useMeltOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await result.current.prepare(MELT_PREPARE_INPUT);
    });

    expect(result.current.currentOperation).toEqual(prepared);

    await act(async () => {
      await result.current.execute();
    });

    expect(melt.execute).toHaveBeenCalledWith(prepared.id);
    expect(result.current.currentOperation).toEqual(executeResult);
    expect(result.current.executeResult).toEqual(executeResult);

    await act(async () => {
      await result.current.finalize();
    });

    expect(melt.finalize).toHaveBeenCalledWith(prepared.id);
    expect(result.current.currentOperation).toEqual(finalized);
    expect(result.current.executeResult).toEqual(executeResult);
  });

  it('supports initial operation-id binding, keeps query helpers stateless, and clears executeResult on reclaim', async () => {
    const { manager, melt } = createMeltManagerMock();
    const loaded = createPreparedMeltOperation({ id: 'melt-op-load' });
    const executeResult = createPendingMeltOperation({ id: loaded.id });
    const rolledBack = createRolledBackMeltOperation({ id: loaded.id });

    melt.get.mockResolvedValueOnce(loaded).mockResolvedValueOnce(rolledBack);
    melt.execute.mockResolvedValue(executeResult);
    melt.listPrepared.mockResolvedValue([loaded]);
    melt.listInFlight.mockResolvedValue([executeResult]);
    melt.reclaim.mockResolvedValue(undefined);

    const { result } = renderHook(() => useMeltOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(loaded);
    });

    const preparedList = await result.current.listPrepared();
    const inFlightList = await result.current.listInFlight();

    expect(preparedList).toEqual([loaded]);
    expect(inFlightList).toEqual([executeResult]);
    expect(result.current.currentOperation).toEqual(loaded);

    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.currentOperation).toEqual(executeResult);
    expect(result.current.executeResult).toEqual(executeResult);

    await act(async () => {
      await result.current.reclaim();
    });

    expect(melt.reclaim).toHaveBeenCalledWith(loaded.id);
    expect(result.current.currentOperation).toEqual(rolledBack);
    expect(result.current.executeResult).toBeNull();
  });

  it('reacts to background events for the bound melt operation id and ignores others', async () => {
    const { manager, melt, emit } = createMeltManagerMock();
    const loaded = createPreparedMeltOperation({ id: 'melt-op-events' });
    const finalized = createFinalizedMeltOperation({ id: loaded.id });

    melt.get.mockResolvedValueOnce(loaded);

    const { result } = renderHook(() => useMeltOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(loaded);
    });

    await emit('melt-op:finalized', {
      mintUrl: loaded.mintUrl,
      operationId: loaded.id,
      operation: finalized,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(finalized);
    });

    await emit('melt-op:finalized', {
      mintUrl: loaded.mintUrl,
      operationId: 'melt-op-other',
      operation: createFinalizedMeltOperation({ id: 'melt-op-other' }),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.currentOperation).toEqual(finalized);
  });

  it('rejects prepare when the hook is already bound to a melt operation', async () => {
    const { manager, melt } = createMeltManagerMock();
    const loaded = createPreparedMeltOperation({ id: 'melt-op-bound' });

    const { result } = renderHook(() => useMeltOperation(loaded), {
      wrapper: createHookWrapper(manager),
    });

    await expect(result.current.prepare(MELT_PREPARE_INPUT)).rejects.toThrow(
      `Cannot call prepare while this hook is bound to operation ${loaded.id}. Remount the hook with a new React key or call reset() first.`,
    );
    expect(melt.prepare).not.toHaveBeenCalled();
    expect(result.current.currentOperation).toEqual(loaded);
  });

  it('keeps the newer melt operation when hydration resolves with an older snapshot', async () => {
    const { manager, melt, emit } = createMeltManagerMock();
    const loaded = createPreparedMeltOperation({ id: 'melt-op-hydrate', updatedAt: 10 });
    const finalized = createFinalizedMeltOperation({ id: loaded.id, updatedAt: 20 });
    const deferredLoad = createDeferred<MeltOperationRecord | null>();

    melt.get.mockReturnValue(deferredLoad.promise);

    const { result } = renderHook(() => useMeltOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await Promise.resolve();
    });

    await emit('melt-op:finalized', {
      mintUrl: loaded.mintUrl,
      operationId: loaded.id,
      operation: finalized,
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(finalized);
    });

    deferredLoad.resolve(loaded);
    await act(async () => {
      await deferredLoad.promise;
    });

    expect(result.current.currentOperation).toEqual(finalized);
    expect(melt.get).toHaveBeenCalledTimes(1);
  });
});
