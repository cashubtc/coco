import { Amount, type Manager, type MintSwapOperation } from '@cashu/coco-core';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagerProvider } from '../providers/Manager.tsx';
import { createDeferred, createHookWrapper, createStrictHookWrapper } from '../../test/testUtils';
import { useMintSwapOperation } from './useMintSwapOperation';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function operation(
  state: 'preparing' | 'prepared' | 'completed' | 'cancelled',
  revision: number,
  id = 'swap',
): MintSwapOperation {
  const base = {
    id,
    revision,
    sourceMintUrl: 'https://source.example',
    destinationMintUrl: 'https://destination.example',
    unit: 'sat' as const,
    destinationAmount: Amount.from(100),
    sourceQuote: {
      mintUrl: 'https://source.example',
      method: 'bolt11' as const,
      quoteId: `source-${id}`,
    },
    destinationQuote: {
      mintUrl: 'https://destination.example',
      method: 'bolt11' as const,
      quoteId: `destination-${id}`,
    },
    sourceOperationId: `source-child-${id}`,
    destinationOperationId: `destination-child-${id}`,
    paymentRequestHash: 'ab'.repeat(32),
    createdAt: 1_000,
    updatedAt: 1_000 + revision,
    stateEnteredAt: 1_000 + revision,
    retry: { attemptCount: 0, lastAttemptAt: null, nextAttemptAt: null, lastError: null },
  };
  if (state === 'preparing') return { ...base, state };
  const sourceDebitBounds = {
    minimum: Amount.from(100),
    maximum: Amount.from(110),
    reserved: Amount.from(110),
  };
  if (state === 'prepared') return { ...base, state, sourceDebitBounds };
  if (state === 'cancelled') {
    return {
      ...base,
      state,
      cancellationRequestedAt: base.stateEnteredAt,
      lastSafe: {
        state: 'prepared',
        stateEnteredAt: base.stateEnteredAt,
        sourceDebitBounds,
      },
      valueNeutral: {
        sourcePayment: 'not_authorized',
        sourceProofs: 'released',
        verifiedAt: base.stateEnteredAt,
      },
      cancelledAt: base.stateEnteredAt,
    };
  }
  return {
    ...base,
    state,
    sourceDebitBounds,
    sourceStartedAt: 1_100,
    sourceSettlement: {
      reserved: Amount.from(110),
      returned: Amount.from(5),
      finalDebit: Amount.from(105),
      totalFee: Amount.from(5),
      sourcePaidObservedAt: 1_200,
    },
    destinationStartedAt: 1_300,
    destinationCompletion: {
      quoteAmountIssued: Amount.from(100),
      storedProofAmount: Amount.from(100),
      proofsVerifiedAt: 1_400,
    },
    completedAt: 1_400,
  };
}

function managerMock() {
  const listeners = new Set<(payload: { operationId: string }) => void>();
  const mintSwap = {
    prepare: vi.fn(),
    execute: vi.fn(),
    get: vi.fn(),
    listActive: vi.fn(),
    refresh: vi.fn(),
    cancel: vi.fn(),
    waitForOutcome: vi.fn(),
    recovery: { run: vi.fn() },
  };
  const on = vi.fn((_event: string, listener: (payload: { operationId: string }) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  return {
    manager: { ops: { mintSwap }, on } as unknown as Manager,
    mintSwap,
    emit(operationId = 'swap') {
      for (const listener of listeners) listener({ operationId });
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useMintSwapOperation', () => {
  it('reports loading and success while hydrating a string binding', async () => {
    const mock = managerMock();
    const pending = createDeferred<MintSwapOperation | null>();
    const prepared = operation('prepared', 1);
    mock.mintSwap.get.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useMintSwapOperation('swap'), {
      wrapper: createHookWrapper(mock.manager),
    });

    expect(result.current.status).toBe('loading');
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      pending.resolve(prepared);
      await pending.promise;
    });

    expect(result.current.currentOperation).toEqual(prepared);
    expect(result.current.status).toBe('success');
    expect(result.current.isLoading).toBe(false);
  });

  it('settles a missing string binding without polling forever and permits prepare', async () => {
    vi.useFakeTimers();
    const mock = managerMock();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prepared = operation('prepared', 1);
    mock.mintSwap.get.mockResolvedValue(null);
    mock.mintSwap.prepare.mockResolvedValue(prepared);
    const { result } = renderHook(() => useMintSwapOperation('missing-swap'), {
      wrapper: createHookWrapper(mock.manager),
    });
    await flush();

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('Operation missing-swap not found');
    expect(mock.mintSwap.get).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mock.mintSwap.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.prepare({
        id: prepared.id,
        sourceMintUrl: prepared.sourceMintUrl,
        destinationMintUrl: prepared.destinationMintUrl,
        destinationAmount: 100,
      });
    });
    expect(result.current.currentOperation).toEqual(prepared);
    expect(result.current.status).toBe('success');
  });

  it('subscribes before reading and orders observed snapshots by parent revision', async () => {
    const mock = managerMock();
    const calls: string[] = [];
    const originalOn = mock.manager.on.bind(mock.manager);
    mock.manager.on = vi.fn(
      (event: Parameters<Manager['on']>[0], listener: Parameters<Manager['on']>[1]) => {
        calls.push(`on:${String(event)}`);
        return originalOn(event, listener);
      },
    ) as Manager['on'];
    mock.mintSwap.get
      .mockImplementationOnce(async () => {
        calls.push('get');
        return operation('prepared', 2);
      })
      .mockResolvedValueOnce(operation('prepared', 1));

    const { result } = renderHook(() => useMintSwapOperation('swap'), {
      wrapper: createHookWrapper(mock.manager),
    });
    await flush();

    expect(calls.slice(0, 2)).toEqual(['on:mint-swap:updated', 'get']);
    expect(result.current.currentOperation?.revision).toBe(2);
    act(() => mock.emit());
    await flush();
    expect(result.current.currentOperation?.revision).toBe(2);
  });

  it('clears a recovered hydration error without erasing a later command error', async () => {
    const mock = managerMock();
    const hydrationError = new Error('local read unavailable');
    const commandError = new Error('refresh failed');
    const recovered = operation('prepared', 1);
    const observed = operation('prepared', 2);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mock.mintSwap.get
      .mockRejectedValueOnce(hydrationError)
      .mockResolvedValueOnce(recovered)
      .mockResolvedValueOnce(observed);
    mock.mintSwap.refresh.mockRejectedValue(commandError);
    const { result } = renderHook(() => useMintSwapOperation('swap'), {
      wrapper: createHookWrapper(mock.manager),
    });
    await flush();

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe(hydrationError);
    expect(result.current.currentOperation).toBeNull();

    act(() => mock.emit());
    await flush();
    expect(result.current.currentOperation).toEqual(recovered);
    expect(result.current.status).toBe('success');
    expect(result.current.error).toBeNull();

    await act(async () => {
      await expect(result.current.refresh()).rejects.toThrow('refresh failed');
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe(commandError);

    act(() => mock.emit());
    await flush();
    expect(result.current.currentOperation).toEqual(observed);
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe(commandError);
  });

  it('runs explicit commands while passive observation never invokes effects', async () => {
    vi.useFakeTimers();
    const mock = managerMock();
    const prepared = operation('prepared', 1);
    const completed = operation('completed', 2);
    mock.mintSwap.get.mockResolvedValue(prepared);
    mock.mintSwap.prepare.mockResolvedValue(prepared);
    mock.mintSwap.execute.mockResolvedValue(completed);
    mock.mintSwap.cancel.mockResolvedValue(completed);
    mock.mintSwap.refresh.mockResolvedValue(completed);
    mock.mintSwap.listActive.mockResolvedValue([prepared]);

    const { result } = renderHook(() => useMintSwapOperation(), {
      wrapper: createHookWrapper(mock.manager),
    });
    await act(async () => {
      await result.current.prepare({
        id: 'swap',
        sourceMintUrl: prepared.sourceMintUrl,
        destinationMintUrl: prepared.destinationMintUrl,
        destinationAmount: 100,
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => mock.emit());
    await flush();
    expect(mock.mintSwap.get).toHaveBeenCalled();
    expect(mock.mintSwap.execute).not.toHaveBeenCalled();
    expect(mock.mintSwap.refresh).not.toHaveBeenCalled();
    expect(mock.mintSwap.recovery.run).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.currentOperation?.state).toBe('completed');
    expect(result.current.executeResult).toEqual(completed);
    await expect(result.current.listActive()).resolves.toEqual([prepared]);
  });

  it('keeps wait passive and binds its revision-safe domain result', async () => {
    const mock = managerMock();
    const prepared = operation('prepared', 1);
    const completed = operation('completed', 2);
    mock.mintSwap.get.mockResolvedValue(prepared);
    mock.mintSwap.waitForOutcome.mockResolvedValue({ status: 'completed', operation: completed });
    const { result } = renderHook(() => useMintSwapOperation(prepared), {
      wrapper: createHookWrapper(mock.manager),
    });
    await flush();

    await act(async () => {
      await expect(result.current.waitForOutcome({ timeoutMs: 5 })).resolves.toEqual({
        status: 'completed',
        operation: completed,
      });
    });
    expect(result.current.currentOperation).toEqual(completed);
    expect(mock.mintSwap.execute).not.toHaveBeenCalled();
    expect(mock.mintSwap.refresh).not.toHaveBeenCalled();
  });

  it('keeps passive waiter failures out of command status', async () => {
    const mock = managerMock();
    const prepared = operation('prepared', 1);
    const executed = operation('prepared', 2);
    mock.mintSwap.get.mockResolvedValue(prepared);
    mock.mintSwap.execute.mockResolvedValue(executed);
    mock.mintSwap.waitForOutcome.mockRejectedValue(new Error('wait transport failed'));
    const { result } = renderHook(() => useMintSwapOperation(prepared), {
      wrapper: createHookWrapper(mock.manager),
    });
    await flush();

    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.status).toBe('success');

    await act(async () => {
      await expect(result.current.waitForOutcome()).rejects.toThrow('wait transport failed');
    });
    expect(result.current.status).toBe('success');
    expect(result.current.error).toBeNull();
  });

  it('clears the execute result when cancellation succeeds', async () => {
    const mock = managerMock();
    const prepared = operation('prepared', 1);
    const executed = operation('prepared', 2);
    const cancelled = operation('cancelled', 3);
    mock.mintSwap.get.mockResolvedValue(prepared);
    mock.mintSwap.execute.mockResolvedValue(executed);
    mock.mintSwap.cancel.mockResolvedValue(cancelled);
    const { result } = renderHook(() => useMintSwapOperation(prepared), {
      wrapper: createHookWrapper(mock.manager),
    });
    await flush();

    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.executeResult).toEqual(executed);

    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.currentOperation).toEqual(cancelled);
    expect(result.current.executeResult).toBeNull();
  });

  it('fences a late command after reset without releasing its command lock', async () => {
    const mock = managerMock();
    const deferred = createDeferred<MintSwapOperation>();
    const prepared = operation('prepared', 1);
    mock.mintSwap.prepare.mockReturnValueOnce(deferred.promise).mockResolvedValueOnce(prepared);
    const { result } = renderHook(() => useMintSwapOperation(), {
      wrapper: createHookWrapper(mock.manager),
    });

    let first!: Promise<MintSwapOperation>;
    act(() => {
      first = result.current.prepare({
        id: 'swap',
        sourceMintUrl: prepared.sourceMintUrl,
        destinationMintUrl: prepared.destinationMintUrl,
        destinationAmount: 100,
      });
    });
    act(() => result.current.reset());

    await expect(
      result.current.prepare({
        id: 'swap',
        sourceMintUrl: prepared.sourceMintUrl,
        destinationMintUrl: prepared.destinationMintUrl,
        destinationAmount: 100,
      }),
    ).rejects.toThrow('Operation already in progress');
    expect(mock.mintSwap.prepare).toHaveBeenCalledTimes(1);

    deferred.resolve(prepared);
    await first;
    expect(result.current.currentOperation).toBeNull();

    await act(async () => {
      await result.current.prepare({
        id: 'swap',
        sourceMintUrl: prepared.sourceMintUrl,
        destinationMintUrl: prepared.destinationMintUrl,
        destinationAmount: 100,
      });
    });
    expect(result.current.currentOperation).toEqual(prepared);
  });

  it('rejects concurrent explicit commands without blocking passive waits', async () => {
    const mock = managerMock();
    const prepared = operation('prepared', 1);
    const command = createDeferred<MintSwapOperation>();
    mock.mintSwap.get.mockResolvedValue(prepared);
    mock.mintSwap.execute.mockReturnValue(command.promise);
    mock.mintSwap.waitForOutcome.mockResolvedValue({ status: 'timeout', operation: prepared });
    const { result } = renderHook(() => useMintSwapOperation(prepared), {
      wrapper: createHookWrapper(mock.manager),
    });
    await flush();

    let executing!: Promise<MintSwapOperation>;
    act(() => {
      executing = result.current.execute();
    });
    await expect(result.current.cancel()).rejects.toThrow('Operation already in progress');
    await expect(result.current.waitForOutcome({ timeoutMs: 0 })).resolves.toMatchObject({
      status: 'timeout',
    });
    command.resolve(operation('completed', 2));
    await executing;
  });

  it('clears and rehydrates from a replacement Manager while fencing the old read', async () => {
    const first = managerMock();
    const second = managerMock();
    const oldRead = createDeferred<MintSwapOperation | null>();
    const replacement = operation('prepared', 1);
    first.mintSwap.get.mockReturnValue(oldRead.promise);
    second.mintSwap.get.mockResolvedValue(replacement);
    let selectedManager = first.manager;
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <ManagerProvider manager={selectedManager}>{children}</ManagerProvider>
    );
    const { result, rerender } = renderHook(() => useMintSwapOperation('swap'), {
      wrapper: Wrapper,
    });
    selectedManager = second.manager;
    rerender();
    await flush();
    expect(result.current.currentOperation).toEqual(replacement);

    oldRead.resolve(operation('completed', 9));
    await flush();
    expect(result.current.currentOperation).toEqual(replacement);
  });

  it('settles when a replacement Manager does not contain the bound operation', async () => {
    vi.useFakeTimers();
    const first = managerMock();
    const second = managerMock();
    const prepared = operation('prepared', 1);
    first.mintSwap.get.mockResolvedValue(prepared);
    second.mintSwap.get.mockResolvedValue(null);
    let selectedManager = first.manager;
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <ManagerProvider manager={selectedManager}>{children}</ManagerProvider>
    );
    const { result, rerender } = renderHook(() => useMintSwapOperation('swap'), {
      wrapper: Wrapper,
    });
    await flush();
    expect(result.current.currentOperation).toEqual(prepared);

    selectedManager = second.manager;
    rerender();
    await flush();

    expect(result.current.currentOperation).toBeNull();
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('Operation swap not found');
    expect(second.mintSwap.get).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(second.mintSwap.get).toHaveBeenCalledTimes(1);
  });

  it('keeps an old Manager command locked until its submitted effect settles', async () => {
    const first = managerMock();
    const second = managerMock();
    const prepared = operation('prepared', 1);
    const refreshed = operation('prepared', 2);
    const oldCommand = createDeferred<MintSwapOperation>();
    first.mintSwap.get.mockResolvedValue(prepared);
    first.mintSwap.execute.mockReturnValue(oldCommand.promise);
    second.mintSwap.get.mockResolvedValue(prepared);
    second.mintSwap.refresh.mockResolvedValue(refreshed);
    let selectedManager = first.manager;
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <ManagerProvider manager={selectedManager}>{children}</ManagerProvider>
    );
    const { result, rerender } = renderHook(() => useMintSwapOperation('swap'), {
      wrapper: Wrapper,
    });
    await flush();

    let executing!: Promise<MintSwapOperation>;
    act(() => {
      executing = result.current.execute();
    });
    selectedManager = second.manager;
    rerender();
    await flush();

    await expect(result.current.refresh()).rejects.toThrow('Operation already in progress');
    expect(second.mintSwap.refresh).not.toHaveBeenCalled();

    oldCommand.resolve(operation('completed', 2));
    await executing;
    await act(async () => {
      await result.current.refresh();
    });
    expect(second.mintSwap.refresh).toHaveBeenCalledWith('swap');
    expect(result.current.currentOperation).toEqual(refreshed);
  });

  it('keeps one logical observer under StrictMode', async () => {
    const mock = managerMock();
    mock.mintSwap.get.mockResolvedValue(operation('completed', 1));
    const { unmount } = renderHook(() => useMintSwapOperation('swap'), {
      wrapper: createStrictHookWrapper(mock.manager),
    });
    await flush();
    expect(mock.listenerCount()).toBe(1);
    unmount();
    expect(mock.listenerCount()).toBe(0);
  });
});
