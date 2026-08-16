import { Amount, type Manager, type MintSwapOperation } from '@cashu/coco-core';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHookWrapper } from '../../test/testUtils';
import { useMintSwapOperation } from './useMintSwapOperation';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Operation = MintSwapOperation;

function operation(revision: number, state = 'preparing'): Operation {
  return {
    id: 'swap',
    revision,
    updatedAt: revision,
    createdAt: 0,
    state,
    sourceMintUrl: 'https://source.test',
    destinationMintUrl: 'https://destination.test',
    unit: 'sat',
    destinationAmount: Amount.from(1),
    requiredDispatchWindowSeconds: 60,
    retry: { attemptCount: 0 },
    destinationNut20Key: { publicKey: '02aa', derivationIndex: 0 },
  } as Operation;
}

function createEvents() {
  const listeners = new Map<
    string,
    Set<(payload: { operationId: string; revision: number }) => void>
  >();
  const source = {
    on: vi.fn(
      (
        event: string,
        handler: (payload: { operationId: string; revision: number }) => void | Promise<void>,
      ) => {
        const handlers = listeners.get(event) ?? new Set();
        handlers.add(handler);
        listeners.set(event, handlers);
        return () => handlers.delete(handler);
      },
    ),
  };
  return {
    source,
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    emit: async (event: string, payload: { operationId: string; revision: number }) => {
      for (const handler of listeners.get(event) ?? []) await handler(payload);
    },
  };
}

describe('useMintSwapOperation', () => {
  it('loads newer event revisions and ignores stale replay', async () => {
    const events = createEvents();
    let stored = operation(2, 'source_inflight');
    const client = {
      get: vi.fn(async () => stored),
      prepare: vi.fn(),
      execute: vi.fn(),
      reconcile: vi.fn(),
      cancel: vi.fn(),
      list: vi.fn(),
    };
    const manager = { ops: { mintSwap: client }, on: events.source.on } as unknown as Manager;
    const { result } = renderHook(() => useMintSwapOperation(operation(2, 'source_inflight')), {
      wrapper: createHookWrapper(manager),
    });

    await act(async () => {
      await events.emit('mint-swap-op:delayed', { operationId: 'swap', revision: 1 });
    });
    expect(client.get).not.toHaveBeenCalled();

    stored = operation(3, 'destination_funded');
    await act(async () => {
      await events.emit('mint-swap-op:destination-funded', {
        operationId: 'swap',
        revision: 3,
      });
    });
    expect(result.current.currentOperation).toEqual(stored);
  });

  it('does not let an older action result overwrite a newer event', async () => {
    const events = createEvents();
    let stored = operation(1, 'source_inflight');
    let resolveReconcile!: (value: Operation) => void;
    const reconciliation = new Promise<Operation>((resolve) => {
      resolveReconcile = resolve;
    });
    const client = {
      get: vi.fn(async () => stored),
      prepare: vi.fn(),
      execute: vi.fn(),
      reconcile: vi.fn(async () => reconciliation),
      cancel: vi.fn(),
      list: vi.fn(),
    };
    const manager = { ops: { mintSwap: client }, on: events.source.on } as unknown as Manager;
    const { result } = renderHook(() => useMintSwapOperation(operation(1, 'source_inflight')), {
      wrapper: createHookWrapper(manager),
    });

    let action!: Promise<Operation>;
    act(() => {
      action = result.current.reconcile();
    });
    stored = operation(3, 'destination_funded');
    await act(async () => {
      await events.emit('mint-swap-op:destination-funded', {
        operationId: 'swap',
        revision: 3,
      });
    });
    await act(async () => {
      resolveReconcile(operation(2, 'source_inflight'));
      await action;
    });

    expect(result.current.currentOperation).toEqual(stored);
  });

  it('ignores foreign operation events and removes every listener on unmount', async () => {
    const events = createEvents();
    const stored = operation(2, 'source_inflight');
    const client = {
      get: vi.fn(async () => stored),
      prepare: vi.fn(),
      execute: vi.fn(),
      reconcile: vi.fn(),
      cancel: vi.fn(),
      list: vi.fn(),
    };
    const manager = { ops: { mintSwap: client }, on: events.source.on } as unknown as Manager;
    const { result, unmount } = renderHook(() => useMintSwapOperation(stored), {
      wrapper: createHookWrapper(manager),
    });

    expect(events.listenerCount()).toBe(9);
    await act(async () => {
      await events.emit('mint-swap-op:completed', { operationId: 'another-swap', revision: 3 });
    });
    expect(client.get).not.toHaveBeenCalled();
    expect(result.current.currentOperation).toEqual(stored);

    unmount();
    expect(events.listenerCount()).toBe(0);
  });
});
