import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type MintSwapClient,
  type MintSwapEventSource,
  type MintSwapOperationView,
  useMintSwapOperation,
} from './useMintSwapOperation';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Operation = MintSwapOperationView & { state: string };

function operation(revision: number, state = 'preparing'): Operation {
  return { id: 'swap', revision, updatedAt: revision, state };
}

function createEvents() {
  const listeners = new Map<
    string,
    Set<(payload: { operationId: string; revision: number }) => void>
  >();
  const source: MintSwapEventSource = {
    on: vi.fn(
      (
        event: Parameters<MintSwapEventSource['on']>[0],
        handler: Parameters<MintSwapEventSource['on']>[1],
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
    } as unknown as MintSwapClient<Operation>;
    const { result } = renderHook(() =>
      useMintSwapOperation(client, events.source, operation(2, 'source_inflight')),
    );

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
    } as unknown as MintSwapClient<Operation>;
    const { result } = renderHook(() =>
      useMintSwapOperation(client, events.source, operation(1, 'source_inflight')),
    );

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
});
