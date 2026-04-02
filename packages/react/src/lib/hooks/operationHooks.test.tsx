import type { Manager } from '@cashu/coco-core';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createHookWrapper, createStrictHookWrapper } from '../../test/testUtils';
import type { SendOperationPrepareInput } from './useSendOperation';
import { useSendOperation } from './useSendOperation';
import type { ReceiveOperationPrepareInput } from './useReceiveOperation';
import { useReceiveOperation } from './useReceiveOperation';
import type { MintOperationImportQuoteInput, MintOperationPrepareInput } from './useMintOperation';
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
  mintUrl: MINT_URL,
  amount: 100,
  method: 'bolt11',
};
const MINT_IMPORT_QUOTE_INPUT: MintOperationImportQuoteInput = {
  mintUrl: MINT_URL,
  method: 'bolt11',
  quote: {
    quote: 'mint-quote-1',
    request: 'lnbc1importquote',
    expiry: 1_700_000_100_000,
    state: 'UNPAID',
    amount: 100,
    unit: 'sat',
  },
};
const MELT_PREPARE_INPUT: MeltOperationPrepareInput = {
  mintUrl: MINT_URL,
  method: 'bolt11',
  methodData: { invoice: 'lnbc1meltinvoice' },
};

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

  return {
    manager: { ops: { send } } as unknown as Manager,
    send,
  };
}

function createReceiveManagerMock() {
  const receive = {
    prepare: vi.fn(),
    execute: vi.fn(),
    get: vi.fn(),
    listPrepared: vi.fn(),
    listInFlight: vi.fn(),
    refresh: vi.fn(),
    cancel: vi.fn(),
  };

  return {
    manager: { ops: { receive } } as unknown as Manager,
    receive,
  };
}

function createMintManagerMock() {
  const mint = {
    prepare: vi.fn(),
    importQuote: vi.fn(),
    execute: vi.fn(),
    get: vi.fn(),
    getByQuote: vi.fn(),
    listPending: vi.fn(),
    listInFlight: vi.fn(),
    checkPayment: vi.fn(),
    refresh: vi.fn(),
    finalize: vi.fn(),
  };

  return {
    manager: { ops: { mint } } as unknown as Manager,
    mint,
  };
}

function createMeltManagerMock() {
  const melt = {
    prepare: vi.fn(),
    execute: vi.fn(),
    get: vi.fn(),
    getByQuote: vi.fn(),
    listPrepared: vi.fn(),
    listInFlight: vi.fn(),
    refresh: vi.fn(),
    cancel: vi.fn(),
    reclaim: vi.fn(),
    finalize: vi.fn(),
  };

  return {
    manager: { ops: { melt } } as unknown as Manager,
    melt,
  };
}

function createPreparedSendOperation(
  overrides: Partial<SendPrepareResult> = {},
): SendPrepareResult {
  return {
    id: 'send-op-1',
    state: 'prepared',
    mintUrl: MINT_URL,
    amount: 100,
    method: 'default',
    methodData: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    needsSwap: false,
    fee: 0,
    inputAmount: 100,
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
  overrides: Partial<ReceivePrepareResult> = {},
): ReceivePrepareResult {
  return {
    id: 'receive-op-1',
    state: 'prepared',
    mintUrl: MINT_URL,
    amount: 100,
    inputProofs: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    fee: 0,
    outputData: {} as ReceivePrepareResult['outputData'],
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
    amount: 100,
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
    ...overrides,
  };
}

function createRolledBackReceiveOperation(
  overrides: Partial<ReceiveOperationRecord> = {},
): ReceiveOperationRecord {
  return {
    ...createPreparedReceiveOperation(),
    state: 'rolled_back',
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
    amount: 100,
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
    lastObservedRemoteState: 'ISSUED',
    lastObservedRemoteStateAt: 1_700_000_020_000,
    ...overrides,
  } as MintExecuteResult;
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
    amount: 100,
    fee_reserve: 1,
    quoteId: 'melt-quote-1',
    swap_fee: 0,
    inputAmount: 101,
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
    ...overrides,
  } as MeltOperationRecord;
}

function createFinalizedMeltOperation(
  overrides: Partial<MeltOperationRecord> = {},
): MeltOperationRecord {
  return {
    ...createPendingMeltOperation(),
    state: 'finalized',
    ...overrides,
  } as MeltOperationRecord;
}

function createRolledBackMeltOperation(
  overrides: Partial<MeltOperationRecord> = {},
): MeltOperationRecord {
  return {
    ...createPreparedMeltOperation(),
    state: 'rolled_back',
    ...overrides,
  } as MeltOperationRecord;
}

describe('useSendOperation', () => {
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

  it('supports initial operation-id binding, rebinds through load, and reset clears only local state', async () => {
    const { manager, send } = createSendManagerMock();
    const loaded = createPreparedSendOperation({ id: 'send-op-load' });
    const rebound = createPreparedSendOperation({ id: 'send-op-rebound' });
    const reboundExecuteResult = createSendExecuteResult({
      operation: createPendingSendOperation({ id: rebound.id }),
    });

    send.get.mockResolvedValueOnce(loaded).mockResolvedValueOnce(rebound);
    send.execute.mockResolvedValue(reboundExecuteResult);
    send.listPrepared.mockResolvedValue([loaded]);
    send.listInFlight.mockResolvedValue([reboundExecuteResult.operation]);

    const { result } = renderHook(() => useSendOperation(loaded.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(loaded);
    });

    const preparedList = await result.current.listPrepared();
    const inFlightList = await result.current.listInFlight();

    expect(preparedList).toEqual([loaded]);
    expect(inFlightList).toEqual([reboundExecuteResult.operation]);
    expect(result.current.currentOperation).toEqual(loaded);

    await act(async () => {
      await result.current.load(rebound.id);
    });

    expect(result.current.currentOperation).toEqual(rebound);

    await act(async () => {
      await result.current.execute();
    });

    expect(send.execute).toHaveBeenCalledWith(rebound.id);
    expect(result.current.currentOperation).toEqual(reboundExecuteResult.operation);

    act(() => {
      result.current.reset();
    });

    expect(result.current.currentOperation).toBeNull();
    expect(result.current.executeResult).toBeNull();
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
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

    await expect(result.current.load('send-op-2')).rejects.toThrow('Operation already in progress');
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

  it('accepts an initial operation binding, synchronizes after cancel, and surfaces errors', async () => {
    const { manager, receive } = createReceiveManagerMock();
    const loaded = createPreparedReceiveOperation({ id: 'receive-op-load' });
    const rolledBack = createRolledBackReceiveOperation({ id: loaded.id });

    receive.get.mockResolvedValue(rolledBack);
    receive.cancel.mockResolvedValue(undefined);

    const { result } = renderHook(() => useReceiveOperation(loaded), {
      wrapper: createHookWrapper(manager),
    });

    expect(result.current.currentOperation).toEqual(loaded);

    await act(async () => {
      await result.current.cancel();
    });

    expect(receive.cancel).toHaveBeenCalledWith(loaded.id);
    expect(result.current.currentOperation).toEqual(rolledBack);

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
});

describe('useMintOperation', () => {
  it('prepares and imports quotes into currentOperation', async () => {
    const { manager, mint } = createMintManagerMock();
    const pending = createPendingMintOperation();
    const imported = createPendingMintOperation({ id: 'mint-op-imported' });

    mint.prepare.mockResolvedValue(pending);
    mint.importQuote.mockResolvedValue(imported);

    const { result } = renderHook(() => useMintOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await result.current.prepare(MINT_PREPARE_INPUT);
    });

    expect(result.current.currentOperation).toEqual(pending);

    await act(async () => {
      await result.current.importQuote(MINT_IMPORT_QUOTE_INPUT);
    });

    expect(result.current.currentOperation).toEqual(imported);
    expect(result.current.executeResult).toBeNull();
  });

  it('accepts an initial operation-id binding and synchronizes after checkPayment and execute', async () => {
    const { manager, mint } = createMintManagerMock();
    const pending = createPendingMintOperation();
    const refreshed = createMintOperation({
      id: pending.id,
      lastObservedRemoteState: 'PAID',
      lastObservedRemoteStateAt: 1_700_000_010_000,
    });
    const finalized = createFinalizedMintOperation({ id: pending.id });

    mint.get.mockResolvedValueOnce(pending).mockResolvedValueOnce(refreshed);
    mint.checkPayment.mockResolvedValue(createMintCheckPaymentResult());
    mint.execute.mockResolvedValue(finalized);

    const { result } = renderHook(() => useMintOperation(pending.id), {
      wrapper: createHookWrapper(manager),
    });

    await waitForAssertion(() => {
      expect(result.current.currentOperation).toEqual(pending);
    });

    await act(async () => {
      await result.current.checkPayment();
    });

    expect(result.current.currentOperation).toEqual(refreshed);

    await act(async () => {
      await result.current.execute();
    });

    expect(mint.execute).toHaveBeenCalledWith(pending.id);
    expect(result.current.currentOperation).toEqual(finalized);
    expect(result.current.executeResult).toEqual(finalized);
  });

  it('loads persisted operations and rebinds before execute', async () => {
    const { manager, mint } = createMintManagerMock();
    const loaded = createMintOperation({ id: 'mint-op-load' });
    const rebound = createMintOperation({ id: 'mint-op-rebound' });
    const executeResult = createFinalizedMintOperation({ id: rebound.id });

    mint.get.mockResolvedValueOnce(loaded).mockResolvedValueOnce(rebound);
    mint.execute.mockResolvedValue(executeResult);

    const { result } = renderHook(() => useMintOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await result.current.load(loaded.id);
    });

    await act(async () => {
      await result.current.load(rebound.id);
    });

    expect(result.current.currentOperation).toEqual(rebound);

    await act(async () => {
      await result.current.execute();
    });

    expect(mint.execute).toHaveBeenCalledWith(rebound.id);
    expect(result.current.currentOperation).toEqual(executeResult);
  });
});

describe('useMeltOperation', () => {
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

  it('loads operations, keeps query helpers stateless, and clears executeResult on reclaim', async () => {
    const { manager, melt } = createMeltManagerMock();
    const loaded = createPreparedMeltOperation({ id: 'melt-op-load' });
    const overrideResult = createPendingMeltOperation({ id: 'melt-op-override' });
    const rolledBack = createRolledBackMeltOperation({ id: overrideResult.id });

    melt.get
      .mockResolvedValueOnce(loaded)
      .mockResolvedValueOnce(overrideResult)
      .mockResolvedValueOnce(rolledBack);
    melt.execute.mockResolvedValue(overrideResult);
    melt.listPrepared.mockResolvedValue([loaded]);
    melt.listInFlight.mockResolvedValue([overrideResult]);
    melt.reclaim.mockResolvedValue(undefined);

    const { result } = renderHook(() => useMeltOperation(), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await result.current.load(loaded.id);
    });

    const preparedList = await result.current.listPrepared();
    const inFlightList = await result.current.listInFlight();

    expect(preparedList).toEqual([loaded]);
    expect(inFlightList).toEqual([overrideResult]);
    expect(result.current.currentOperation).toEqual(loaded);

    await act(async () => {
      await result.current.load(overrideResult.id);
    });

    expect(result.current.currentOperation).toEqual(overrideResult);

    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.currentOperation).toEqual(overrideResult);
    expect(result.current.executeResult).toEqual(overrideResult);

    await act(async () => {
      await result.current.reclaim();
    });

    expect(melt.reclaim).toHaveBeenCalledWith(overrideResult.id);
    expect(result.current.currentOperation).toEqual(rolledBack);
    expect(result.current.executeResult).toBeNull();
  });
});
