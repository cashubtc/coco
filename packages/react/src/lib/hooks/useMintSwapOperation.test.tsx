import { Amount, type Manager, type MintSwapOperation } from '@cashu/coco-core';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHookWrapper } from '../../test/testUtils.tsx';
import { useMintSwapOperation } from './useMintSwapOperation.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useMintSwapOperation', () => {
  it('ignores stale revisions, fetches newer durable state, and cleans up listeners', async () => {
    const listeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
    const on = vi.fn((event: string, handler: (payload: unknown) => void | Promise<void>) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
      return () => handlers.delete(handler);
    });
    const prepared = makeOperation();
    const attention = makeOperation({
      revision: 3,
      state: 'needs_attention',
      attention: {
        reason: 'accounting_mismatch',
        message: 'Settlement contradiction',
        lastSafeState: 'destination_funded',
        violatedInvariant: 'settlement',
        evidence: { operationId: 'swap-1' },
        at: 4,
      },
      updatedAt: 4,
    });
    const get = vi.fn(async () => attention);
    const manager = {
      on,
      ops: {
        mintSwap: {
          get,
          prepare: vi.fn(),
          execute: vi.fn(),
          refresh: vi.fn(),
          retry: vi.fn(),
          cancel: vi.fn(),
          list: vi.fn(),
          listActive: vi.fn(),
        },
      },
    } as unknown as Manager;
    const rendered = renderHook(() => useMintSwapOperation(prepared), {
      wrapper: createHookWrapper(manager),
    });

    await emit(listeners, 'mint-swap-op:prepared', { operationId: 'swap-1', revision: 1 });
    expect(get).not.toHaveBeenCalled();
    await act(async () => {
      await emit(listeners, 'mint-swap-op:needs-attention', {
        operationId: 'swap-1',
        revision: 3,
      });
    });
    expect(rendered.result.current.currentOperation).toMatchObject({
      revision: 3,
      state: 'needs_attention',
    });

    rendered.unmount();
    expect(Array.from(listeners.values()).every((handlers) => handlers.size === 0)).toBe(true);
  });
});

async function emit(
  listeners: Map<string, Set<(payload: unknown) => void | Promise<void>>>,
  event: string,
  payload: unknown,
): Promise<void> {
  for (const handler of listeners.get(event) ?? []) await handler(payload);
}

function makeOperation(overrides: Partial<MintSwapOperation> = {}): MintSwapOperation {
  return {
    id: 'swap-1',
    state: 'prepared',
    revision: 2,
    sourceMintUrl: 'https://source.test',
    destinationMintUrl: 'https://destination.test',
    unit: 'sat',
    destinationAmount: Amount.from(100),
    retry: { attemptCount: 0 },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}
