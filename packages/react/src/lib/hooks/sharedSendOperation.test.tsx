import { Amount, initializeCoco, MemoryRepositories } from '@cashu/coco-core';
import type { CoreEvents, Manager, PendingSendOperation } from '@cashu/coco-core';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  testMintInfo,
  testMintKeypairs,
  testMintKeysetId,
} from '../../../../core/test/fixtures/MintMetadata';
import { createDeferred, createHookWrapper } from '../../test/testUtils';
import { ManagerProvider } from '../providers/Manager';
import type { UseSendOperationResult } from './useSendOperation';
import { useSendOperation } from './useSendOperation';

type CoreProofRecord = Parameters<MemoryRepositories['proofRepository']['saveProofs']>[1][number];

const MINT_URL = 'https://mint.example';
const KEYSET_ID = testMintKeysetId();

const managers: Manager[] = [];

beforeEach(() => {
  // The mint is unreachable, so startup recovery leaves any pending Sends untouched.
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('Mint unreachable in this test');
  });
});

afterEach(async () => {
  cleanup();
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.restoreAllMocks();
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
  mintUrl: string,
): Promise<PendingSendOperation> {
  const amount = Amount.from(12);
  const proofs: CoreProofRecord[] = [
    {
      id: KEYSET_ID,
      amount: Amount.from(8),
      secret: `${operationId}-secret-1`,
      C: testMintKeypairs['8'],
      mintUrl,
      unit: 'sat',
      state: 'inflight',
      usedByOperationId: operationId,
    },
    {
      id: KEYSET_ID,
      amount: Amount.from(4),
      secret: `${operationId}-secret-2`,
      C: testMintKeypairs['4'],
      mintUrl,
      unit: 'sat',
      state: 'inflight',
      usedByOperationId: operationId,
    },
  ];
  const operation: PendingSendOperation = {
    id: operationId,
    state: 'pending',
    mintUrl,
    amount,
    unit: 'sat',
    method: 'default',
    methodData: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    revision: 2,
    needsSwap: false,
    fee: Amount.zero(),
    inputAmount: amount,
    inputProofSecrets: proofs.map((proof) => proof.secret),
    token: {
      mint: mintUrl,
      unit: 'sat',
      proofs: proofs.map(({ id, amount, secret, C }) => ({ id, amount, secret, C })),
    },
  };

  await repositories.proofRepository.saveProofs(mintUrl, proofs);
  await repositories.sendOperationRepository.create(operation);
  return operation;
}

async function openWallet(repositories: MemoryRepositories) {
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
  return manager;
}

async function reopenWallet(
  operationId: string,
  { mintUrl = MINT_URL, repositories = new MemoryRepositories() } = {},
) {
  const persisted = await persistPendingSend(repositories, operationId, mintUrl);
  const manager = await openWallet(repositories);
  return { manager, repositories, persisted };
}

async function recordClaimedToken(repositories: MemoryRepositories, send: PendingSendOperation) {
  await repositories.proofRepository.setProofState(send.mintUrl, send.inputProofSecrets, 'spent');
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
      const operation = current(name).currentOperation as PendingSendOperation;
      expect(operation.token).toEqual(persisted.token);
      expect(current(name).status).toBe('success');
    }
    // Both components and their StrictMode effect replays shared one storage read.
    expect(reads).toHaveBeenCalledTimes(1);

    // The recipient claimed the token, and the wallet has recorded that its proofs are spent.
    await recordClaimedToken(repositories, persisted);
    await act(async () => {
      await manager.ops.send.finalize(persisted.id);
    });

    expect(current('first').currentOperation?.state).toBe('finalized');
    expect(current('second').currentOperation?.state).toBe('finalized');
    expect(current('first').currentOperation).toBe(current('second').currentOperation);
  });
});

// Hold one real storage snapshot so it can arrive after a Manager change.
function installSendReadGate(repositories: MemoryRepositories) {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const repository = repositories.sendOperationRepository;
  let holdNext = false;
  repositories.sendOperationRepository = new Proxy(repository, {
    get(target, key) {
      if (key !== 'getById') {
        return Reflect.get(target, key);
      }
      return async (id: string) => {
        const hold = holdNext;
        holdNext = false;
        const record = await target.getById(id);
        if (hold) {
          started.resolve();
          await release.promise;
        }
        return record;
      };
    },
  });
  return () => {
    holdNext = true;
    return { started, release };
  };
}

function renderWithReplaceableManager<T>(initialManager: Manager, useObserver: () => T) {
  let manager = initialManager;
  const { result, rerender } = renderHook(useObserver, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ManagerProvider manager={manager}>{children}</ManagerProvider>
    ),
  });
  return {
    result,
    replaceManager(nextManager: Manager) {
      manager = nextManager;
      rerender();
    },
  };
}

describe('observers of one Send', () => {
  it('shares the record reread by finalize() when the command emits no event', async () => {
    const { manager, repositories, persisted } = await reopenWallet('send-op-action');
    const settlingManager = await openWallet(repositories);
    const { result } = renderHook(
      () => ({ first: useSendOperation(persisted.id), second: useSendOperation(persisted.id) }),
      { wrapper: createHookWrapper(manager) },
    );
    await waitFor(() => {
      expect(result.current.first.currentOperation).toEqual(persisted);
      expect(result.current.second.currentOperation).toEqual(persisted);
    });

    // The other Manager publishes on its own event bus. Repeating finalize() is idempotent.
    await recordClaimedToken(repositories, persisted);
    await settlingManager.ops.send.finalize(persisted.id);
    expect(result.current.second.currentOperation).toEqual(persisted);

    await act(async () => {
      await result.current.first.finalize();
    });

    expect(result.current.first.currentOperation?.state).toBe('finalized');
    expect(result.current.second.currentOperation).toBe(result.current.first.currentOperation);
  });

  it('keeps the remaining observer subscribed after a reset and an unmount', async () => {
    const { manager, repositories, persisted } = await reopenWallet('send-op-observers');
    const subscribe = manager.on.bind(manager);
    const activeSubscriptions = new Set<() => void>();
    vi.spyOn(manager, 'on').mockImplementation(function trackSubscription<
      E extends keyof CoreEvents,
    >(event: E, handler: (payload: CoreEvents[E]) => void | Promise<void>) {
      const unsubscribe = subscribe(event, handler);
      activeSubscriptions.add(unsubscribe);
      return () => {
        unsubscribe();
        activeSubscriptions.delete(unsubscribe);
      };
    });
    const options = strictModeAtRoot(manager);

    const first = renderHook(() => useSendOperation(persisted.id), options);
    const firstSubscriptions = new Set(activeSubscriptions);
    expect(firstSubscriptions.size).toBeGreaterThan(0);
    const second = renderHook(() => useSendOperation(persisted.id), options);
    const third = renderHook(() => useSendOperation(persisted.id), options);
    await waitFor(() => {
      expect(third.result.current.currentOperation).toEqual(persisted);
    });
    expect(activeSubscriptions).toEqual(firstSubscriptions);

    act(() => {
      first.result.current.reset();
    });
    second.unmount();

    await recordClaimedToken(repositories, persisted);
    await act(async () => {
      await manager.ops.send.finalize(persisted.id);
    });
    expect(first.result.current.currentOperation).toBeNull();
    expect(third.result.current.currentOperation?.state).toBe('finalized');

    third.unmount();
    expect(activeSubscriptions.size).toBe(0);
  });

  it('keeps records of different Managers apart when their IDs match', async () => {
    const id = 'send-op-shared-id';
    const left = await reopenWallet(id, { mintUrl: 'https://left.example' });
    const right = await reopenWallet(id, { mintUrl: 'https://right.example' });

    const leftObserver = renderHook(() => useSendOperation(id), {
      wrapper: createHookWrapper(left.manager),
    });
    const rightObserver = renderHook(() => useSendOperation(id), {
      wrapper: createHookWrapper(right.manager),
    });
    await waitFor(() => {
      expect(leftObserver.result.current.currentOperation).toEqual(left.persisted);
      expect(rightObserver.result.current.currentOperation).toEqual(right.persisted);
    });

    await recordClaimedToken(left.repositories, left.persisted);
    await act(async () => {
      await leftObserver.result.current.finalize();
    });

    expect(leftObserver.result.current.currentOperation?.state).toBe('finalized');
    expect(rightObserver.result.current.currentOperation).toEqual(right.persisted);
  });

  it('keeps the replacement record when a read from the previous Manager finishes late', async () => {
    const id = 'send-op-switch';
    const repositories = new MemoryRepositories();
    const holdNextRead = installSendReadGate(repositories);
    const left = await reopenWallet(id, { mintUrl: 'https://left.example', repositories });
    const right = await reopenWallet(id, { mintUrl: 'https://right.example' });
    const read = holdNextRead();

    const { result, replaceManager } = renderWithReplaceableManager(left.manager, () =>
      useSendOperation(id),
    );
    try {
      await read.started.promise;
      replaceManager(right.manager);
      await waitFor(() => {
        expect(result.current.currentOperation).toEqual(right.persisted);
      });
    } finally {
      await act(async () => {
        read.release.resolve();
      });
    }

    expect(result.current.currentOperation).toEqual(right.persisted);
  });

  it('clears an object binding while reading the replacement Manager', async () => {
    const id = 'send-op-own-record';
    const left = await reopenWallet(id, { mintUrl: 'https://left.example' });
    const repositories = new MemoryRepositories();
    const holdNextRead = installSendReadGate(repositories);
    const right = await reopenWallet(id, { mintUrl: 'https://right.example', repositories });

    const { result, replaceManager } = renderWithReplaceableManager(left.manager, () =>
      useSendOperation(left.persisted),
    );
    expect(result.current.currentOperation).toEqual(left.persisted);

    const read = holdNextRead();
    try {
      replaceManager(right.manager);
      expect(result.current.currentOperation).toBeNull();
      await read.started.promise;
    } finally {
      await act(async () => {
        read.release.resolve();
      });
    }

    expect(result.current.currentOperation).toEqual(right.persisted);
  });

  it('rereads a Send selected by prepare() after a Manager change', async () => {
    const repositories = new MemoryRepositories();
    const now = Math.floor(Date.now() / 1000);
    await repositories.mintRepository.addNewMint({
      mintUrl: MINT_URL,
      name: testMintInfo.name,
      mintInfo: testMintInfo,
      trusted: true,
      createdAt: now,
      updatedAt: now,
    });
    await repositories.keysetRepository.addKeyset({
      mintUrl: MINT_URL,
      id: KEYSET_ID,
      unit: 'sat',
      keypairs: testMintKeypairs,
      active: true,
      feePpk: 0,
    });
    await repositories.proofRepository.saveProofs(MINT_URL, [
      {
        id: KEYSET_ID,
        amount: Amount.from(8),
        secret: 'ready-to-send',
        C: testMintKeypairs['8'],
        mintUrl: MINT_URL,
        unit: 'sat',
        state: 'ready',
      },
    ]);

    const manager = await openWallet(repositories);
    const { result, replaceManager } = renderWithReplaceableManager(manager, () =>
      useSendOperation(),
    );
    await act(async () => {
      await result.current.prepare({ mintUrl: MINT_URL, amount: 8 });
    });
    const prepared = result.current.currentOperation!;
    expect(prepared.state).toBe('prepared');

    const replacement = await openWallet(repositories);
    replaceManager(replacement);
    await waitFor(() => {
      expect(result.current.currentOperation).toEqual(prepared);
    });
    expect(result.current.currentOperation).not.toBe(prepared);

    const refresh = vi.spyOn(replacement.ops.send, 'refresh');
    await act(async () => {
      expect(await result.current.refresh()).toEqual(prepared);
    });
    expect(refresh).toHaveBeenCalledWith(prepared.id);
  });

  it('shows a newer record passed as a binding to the other observers', async () => {
    const { manager, repositories, persisted } = await reopenWallet('send-op-object-binding');
    const settlingManager = await openWallet(repositories);
    const wrapper = createHookWrapper(manager);
    const reads = vi.spyOn(manager.ops.send, 'get');
    const reader = renderHook(() => useSendOperation(persisted.id), { wrapper });
    await waitFor(() => {
      expect(reader.result.current.currentOperation).toEqual(persisted);
    });

    await recordClaimedToken(repositories, persisted);
    await settlingManager.ops.send.finalize(persisted.id);
    const finalized = await manager.ops.send.get(persisted.id);
    expect(finalized?.state).toBe('finalized');
    expect(reader.result.current.currentOperation).toEqual(persisted);
    reads.mockClear();

    const bound = renderHook(() => useSendOperation(finalized), { wrapper });

    expect(bound.result.current.currentOperation).toEqual(finalized);
    expect(reader.result.current.currentOperation).toEqual(finalized);
    expect(reads).not.toHaveBeenCalled();
  });

  it('keeps the shared record when a binding passes an older record', async () => {
    const { manager, repositories, persisted } = await reopenWallet('send-op-stale-binding');
    await recordClaimedToken(repositories, persisted);
    await manager.ops.send.finalize(persisted.id);
    const wrapper = createHookWrapper(manager);
    const reader = renderHook(() => useSendOperation(persisted.id), { wrapper });
    await waitFor(() => {
      expect(reader.result.current.currentOperation?.state).toBe('finalized');
    });

    const bound = renderHook(() => useSendOperation(persisted), { wrapper });

    expect(bound.result.current.currentOperation?.state).toBe('finalized');
    expect(reader.result.current.currentOperation).toBe(bound.result.current.currentOperation);
  });
});
