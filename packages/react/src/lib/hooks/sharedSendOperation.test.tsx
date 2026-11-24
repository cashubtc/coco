import { Amount, initializeCoco, MemoryRepositories, type Manager } from '@cashu/coco-core';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagerProvider } from '../providers/Manager';
import { createDeferred, createHookWrapper } from '../../test/testUtils';
import { useSendOperation, type UseSendOperationResult } from './useSendOperation';

type SendOperationRecord = NonNullable<Awaited<ReturnType<Manager['ops']['send']['get']>>>;
type PendingSendOperationRecord = Extract<SendOperationRecord, { state: 'pending' }>;
type CoreProofRecord = Parameters<MemoryRepositories['proofRepository']['saveProofs']>[1][number];

const MINT_URL = 'https://mint.example';
const KEYSET_ID = '00aabbccddeeff00';

const managers: Manager[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.unstubAllGlobals();
});

// React 19 replays effects only when StrictMode wraps the root.
function strictModeAtRoot(manager: Manager) {
  return { wrapper: createHookWrapper(manager), reactStrictMode: true } as const;
}

/**
 * Persists an executed exact-match Send whose token has not been claimed yet, as a previous Coco
 * Session would have left it.
 */
async function persistPendingSend(
  repositories: MemoryRepositories,
  operationId: string,
): Promise<PendingSendOperationRecord> {
  const proofs: CoreProofRecord[] = [
    {
      id: KEYSET_ID,
      amount: Amount.from(64),
      secret: `${operationId}-secret-1`,
      C: '02'.padEnd(66, '1'),
      mintUrl: MINT_URL,
      unit: 'sat',
      state: 'inflight',
      usedByOperationId: operationId,
    },
    {
      id: KEYSET_ID,
      amount: Amount.from(36),
      secret: `${operationId}-secret-2`,
      C: '02'.padEnd(66, '2'),
      mintUrl: MINT_URL,
      unit: 'sat',
      state: 'inflight',
      usedByOperationId: operationId,
    },
  ];
  const operation: PendingSendOperationRecord = {
    id: operationId,
    state: 'pending',
    mintUrl: MINT_URL,
    amount: Amount.from(100),
    unit: 'sat',
    method: 'default',
    methodData: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    revision: 2,
    needsSwap: false,
    fee: Amount.zero(),
    inputAmount: Amount.from(100),
    inputProofSecrets: proofs.map((proof) => proof.secret),
    token: {
      mint: MINT_URL,
      unit: 'sat',
      proofs: proofs.map(({ id, amount, secret, C }) => ({ id, amount, secret, C })),
    },
  };

  await repositories.proofRepository.saveProofs(MINT_URL, proofs);
  await repositories.sendOperationRepository.create(operation);
  return operation;
}

async function reopenWallet(operationId: string) {
  // The mint is unreachable, so startup recovery leaves the pending Send untouched.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Mint unreachable in this test');
    }),
  );

  // A fresh Manager over the stored records stands in for reopening the wallet. Memory
  // repositories copy records in and out, so the Manager never sees the objects written here.
  const repositories = new MemoryRepositories();
  await repositories.init();
  const persisted = await persistPendingSend(repositories, operationId);
  const manager = await initializeCoco({
    repo: repositories,
    seedGetter: async () => new Uint8Array(64).fill(7),
    watchers: {
      mintOperationWatcher: { disabled: true },
      proofStateWatcher: { disabled: true },
      meltQuoteWatcher: { disabled: true },
    },
    processors: {
      mintSwapOperationProcessor: { disabled: true },
      mintOperationProcessor: { disabled: true },
      meltSettlementProcessor: { disabled: true },
    },
  });
  managers.push(manager);

  return { manager, repositories, persisted };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw lastError;
}

describe('a persisted Send shared between two observers', () => {
  it('shows the reopened token and the next lifecycle update to both observers', async () => {
    const { manager, repositories, persisted } = await reopenWallet('send-shared-reopen');

    const reads = vi.spyOn(manager.ops.send, 'get');
    const observed = new Map<string, UseSendOperationResult>();
    function SendObserver({ name }: { name: string }) {
      observed.set(name, useSendOperation(persisted.id));
      return null;
    }
    const current = (name: string) => observed.get(name)!;

    render(
      <>
        <SendObserver name="first" />
        <SendObserver name="second" />
      </>,
      strictModeAtRoot(manager),
    );

    await waitFor(() => {
      expect(current('first').currentOperation?.state).toBe('pending');
      expect(current('second').currentOperation?.state).toBe('pending');
    });
    for (const name of ['first', 'second']) {
      const operation = current(name).currentOperation as PendingSendOperationRecord;
      expect(operation.token).toEqual(persisted.token);
      expect(current(name).status).toBe('success');
    }
    // Both components and their StrictMode effect replays shared one storage read.
    expect(reads).toHaveBeenCalledTimes(1);

    // The recipient claimed the token, and the wallet has recorded that its proofs are spent.
    await repositories.proofRepository.setProofState(
      MINT_URL,
      persisted.inputProofSecrets,
      'spent',
    );
    await act(async () => {
      await manager.ops.send.finalize(persisted.id);
    });

    expect(current('first').currentOperation?.state).toBe('finalized');
    expect(current('second').currentOperation?.state).toBe('finalized');
    expect(current('first').currentOperation).toBe(current('second').currentOperation);
  });
});

function createSendManagerMock() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
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
  const on = vi.fn((event: string, handler: (payload: unknown) => void) => {
    const handlers = listeners.get(event) ?? new Set();
    handlers.add(handler);
    listeners.set(event, handlers);
    return () => {
      handlers.delete(handler);
    };
  });
  const emit = async (event: string, operation: SendOperationRecord) => {
    await act(async () => {
      for (const handler of Array.from(listeners.get(event) ?? [])) {
        handler({ mintUrl: operation.mintUrl, operationId: operation.id, operation });
      }
    });
  };
  const listenerCount = () =>
    Array.from(listeners.values()).reduce((count, handlers) => count + handlers.size, 0);

  return { manager: { ops: { send }, on } as unknown as Manager, send, emit, listenerCount };
}

function sendRecord(overrides: Partial<SendOperationRecord> = {}): SendOperationRecord {
  return {
    id: 'send-op-1',
    state: 'pending',
    mintUrl: MINT_URL,
    amount: Amount.from(100),
    unit: 'sat',
    method: 'default',
    methodData: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    revision: 2,
    needsSwap: false,
    fee: Amount.zero(),
    inputAmount: Amount.from(100),
    inputProofSecrets: ['send-proof-1'],
    token: { mint: MINT_URL, unit: 'sat', proofs: [] },
    ...overrides,
  } as SendOperationRecord;
}

describe('observers of one Send with a fake Manager', () => {
  it("shows one observer's action result to another observer of the same ID", async () => {
    const { manager, send } = createSendManagerMock();
    const pending = sendRecord({ id: 'send-op-action' });
    const finalized = sendRecord({ id: pending.id, state: 'finalized', revision: 3 });
    send.get.mockResolvedValueOnce(pending);
    send.finalize.mockResolvedValue(undefined);

    const { result } = renderHook(
      () => ({ first: useSendOperation(pending.id), second: useSendOperation(pending.id) }),
      { wrapper: createHookWrapper(manager) },
    );
    await waitFor(() => {
      expect(result.current.first.currentOperation).toEqual(pending);
      expect(result.current.second.currentOperation).toEqual(pending);
    });

    // Core emits no event in this fake, so only the reread after the action reveals the change.
    send.get.mockResolvedValue(finalized);
    await act(async () => {
      await result.current.first.finalize();
    });

    expect(result.current.first.currentOperation).toEqual(finalized);
    expect(result.current.second.currentOperation).toEqual(finalized);
    // Both observers shared one initial read; the second read is the reread after finalize().
    expect(send.get).toHaveBeenCalledTimes(2);
  });

  it('keeps the other observer subscribed after one resets or unmounts', async () => {
    const { manager, send, emit, listenerCount } = createSendManagerMock();
    const pending = sendRecord({ id: 'send-op-observers' });
    send.get.mockResolvedValue(pending);
    const options = strictModeAtRoot(manager);

    const first = renderHook(() => useSendOperation(pending.id), options);
    const second = renderHook(() => useSendOperation(pending.id), options);
    const third = renderHook(() => useSendOperation(pending.id), options);
    await waitFor(() => {
      expect(third.result.current.currentOperation).toEqual(pending);
    });

    act(() => {
      first.result.current.reset();
    });
    second.unmount();
    const rolledBack = sendRecord({ id: pending.id, state: 'rolled_back', revision: 3 });
    await emit('send:rolled-back', rolledBack);

    expect(first.result.current.currentOperation).toBeNull();
    expect(third.result.current.currentOperation).toEqual(rolledBack);

    third.unmount();
    expect(listenerCount()).toBe(0);
  });

  it('keeps records of different Managers apart when their IDs match', async () => {
    const left = createSendManagerMock();
    const right = createSendManagerMock();
    const leftRecord = sendRecord({ id: 'send-op-shared-id', mintUrl: 'https://left.example' });
    const rightRecord = sendRecord({ id: leftRecord.id, mintUrl: 'https://right.example' });
    left.send.get.mockResolvedValue(leftRecord);
    right.send.get.mockResolvedValue(rightRecord);

    const leftObserver = renderHook(() => useSendOperation(leftRecord.id), {
      wrapper: createHookWrapper(left.manager),
    });
    const rightObserver = renderHook(() => useSendOperation(rightRecord.id), {
      wrapper: createHookWrapper(right.manager),
    });
    await waitFor(() => {
      expect(leftObserver.result.current.currentOperation).toEqual(leftRecord);
      expect(rightObserver.result.current.currentOperation).toEqual(rightRecord);
    });

    const leftFinalized = sendRecord({ ...leftRecord, state: 'finalized', revision: 3 });
    await left.emit('send:finalized', leftFinalized);

    expect(leftObserver.result.current.currentOperation).toEqual(leftFinalized);
    expect(rightObserver.result.current.currentOperation).toEqual(rightRecord);
  });
  it('reads the new Manager after a Manager change with the same ID', async () => {
    const left = createSendManagerMock();
    const right = createSendManagerMock();
    const leftRead = createDeferred<SendOperationRecord | null>();
    const leftRecord = sendRecord({ id: 'send-op-switch', mintUrl: 'https://left.example' });
    const rightRecord = sendRecord({ id: leftRecord.id, mintUrl: 'https://right.example' });
    left.send.get.mockReturnValue(leftRead.promise);
    right.send.get.mockResolvedValue(rightRecord);
    let manager = left.manager;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ManagerProvider manager={manager}>{children}</ManagerProvider>
    );

    const { result, rerender } = renderHook(() => useSendOperation(leftRecord.id), { wrapper });
    manager = right.manager;
    rerender();
    await waitFor(() => {
      expect(result.current.currentOperation).toEqual(rightRecord);
    });
    await act(async () => {
      leftRead.resolve(leftRecord);
      await leftRead.promise;
    });

    expect(right.send.get).toHaveBeenCalledWith(rightRecord.id);
    expect(result.current.currentOperation).toEqual(rightRecord);
  });

  it('does not show a record from the previous Manager after a Manager change', async () => {
    const left = createSendManagerMock();
    const right = createSendManagerMock();
    const leftRecord = sendRecord({ id: 'send-op-own-record', mintUrl: 'https://left.example' });
    let manager = left.manager;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ManagerProvider manager={manager}>{children}</ManagerProvider>
    );

    const rightRead = createDeferred<SendOperationRecord | null>();
    right.send.get.mockReturnValue(rightRead.promise);

    const { result, rerender } = renderHook(() => useSendOperation(leftRecord), { wrapper });
    expect(result.current.currentOperation).toEqual(leftRecord);

    manager = right.manager;
    rerender();

    expect(result.current.currentOperation).toBeNull();
    const rightRecord = sendRecord({ id: leftRecord.id, mintUrl: 'https://right.example' });
    await act(async () => {
      rightRead.resolve(rightRecord);
      await rightRead.promise;
    });
    expect(result.current.currentOperation).toEqual(rightRecord);
  });

  it('rereads a prepared Send from the new Manager after a Manager change', async () => {
    const left = createSendManagerMock();
    const right = createSendManagerMock();
    const prepared = sendRecord({ id: 'send-op-prepared-switch', state: 'prepared', revision: 1 });
    const reread = sendRecord({ ...prepared, mintUrl: 'https://right.example' });
    const refreshed = sendRecord({ ...reread, revision: 2 });
    left.send.prepare.mockResolvedValue(prepared);
    right.send.get.mockResolvedValue(reread);
    right.send.refresh.mockResolvedValue(refreshed);
    let manager = left.manager;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ManagerProvider manager={manager}>{children}</ManagerProvider>
    );

    const { result, rerender } = renderHook(() => useSendOperation(), { wrapper });
    await act(async () => {
      await result.current.prepare({} as never);
    });
    manager = right.manager;
    rerender();

    await waitFor(() => {
      expect(result.current.currentOperation).toEqual(reread);
    });
    expect(right.send.get).toHaveBeenCalledWith(prepared.id);
    await act(async () => {
      await result.current.refresh();
    });
    expect(right.send.refresh).toHaveBeenCalledWith(prepared.id);
    expect(result.current.currentOperation).toEqual(refreshed);
  });

  it('shows a newer record passed as a binding to the other observers', async () => {
    const { manager, send } = createSendManagerMock();
    const pending = sendRecord({ id: 'send-op-object-binding' });
    const finalized = sendRecord({ id: pending.id, state: 'finalized', revision: 3 });
    send.get.mockResolvedValue(pending);
    const wrapper = createHookWrapper(manager);

    const reader = renderHook(() => useSendOperation(pending.id), { wrapper });
    await waitFor(() => {
      expect(reader.result.current.currentOperation).toEqual(pending);
    });
    const bound = renderHook(() => useSendOperation(finalized), { wrapper });

    expect(bound.result.current.currentOperation).toEqual(finalized);
    expect(reader.result.current.currentOperation).toEqual(finalized);
    expect(send.get).toHaveBeenCalledTimes(1);
  });

  it('keeps the shared record when a binding passes an older record', async () => {
    const { manager, send } = createSendManagerMock();
    const finalized = sendRecord({ id: 'send-op-stale-binding', state: 'finalized', revision: 3 });
    const stale = sendRecord({ id: finalized.id });
    send.get.mockResolvedValue(finalized);
    const wrapper = createHookWrapper(manager);

    const reader = renderHook(() => useSendOperation(finalized.id), { wrapper });
    await waitFor(() => {
      expect(reader.result.current.currentOperation).toEqual(finalized);
    });
    const bound = renderHook(() => useSendOperation(stale), { wrapper });

    expect(bound.result.current.currentOperation).toEqual(finalized);
    expect(reader.result.current.currentOperation).toEqual(finalized);
  });
});

describe('ordering observed Send records', () => {
  it('rejects an older revision even when its updatedAt is later', async () => {
    const { manager, send, emit } = createSendManagerMock();
    const read = createDeferred<SendOperationRecord | null>();
    send.get.mockReturnValue(read.promise);
    const finalized = sendRecord({
      id: 'send-op-revision',
      state: 'finalized',
      revision: 3,
      updatedAt: 1_700_000_002_000,
    });

    const { result } = renderHook(() => useSendOperation(finalized.id), {
      wrapper: createHookWrapper(manager),
    });
    await emit('send:finalized', finalized);
    await act(async () => {
      read.resolve(sendRecord({ id: finalized.id, revision: 2, updatedAt: 1_700_000_009_000 }));
      await read.promise;
    });

    expect(result.current.currentOperation).toEqual(finalized);
  });

  it('treats an absent legacy revision as zero', async () => {
    const { manager, send, emit } = createSendManagerMock();
    const legacy = sendRecord({ id: 'send-op-legacy', revision: undefined, updatedAt: 50 });
    send.get.mockResolvedValue(legacy);

    const { result } = renderHook(() => useSendOperation(legacy.id), {
      wrapper: createHookWrapper(manager),
    });
    await waitFor(() => {
      expect(result.current.currentOperation).toEqual(legacy);
    });

    // A revision-0 record never replaces the legacy record with a later timestamp...
    await emit('send:pending', sendRecord({ id: legacy.id, revision: 0, updatedAt: 40 }));
    expect(result.current.currentOperation).toEqual(legacy);

    // ...but the first transition, which writes revision 1, does.
    const finalized = sendRecord({ id: legacy.id, state: 'finalized', revision: 1, updatedAt: 40 });
    await emit('send:finalized', finalized);
    expect(result.current.currentOperation).toEqual(finalized);
  });
});
