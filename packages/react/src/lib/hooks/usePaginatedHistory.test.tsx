import { Amount, type HistoryEntry, type Manager } from '@cashu/coco-core';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagerProvider } from '../providers/Manager.tsx';
import { createDeferred, createHookWrapper, createStrictHookWrapper } from '../../test/testUtils';
import { usePaginatedHistory } from './usePaginatedHistory';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function entry(id: string, createdAt: number): HistoryEntry {
  return {
    id: `send:${id}`,
    source: 'operation',
    type: 'send',
    operationId: id,
    mintUrl: 'https://mint.example',
    amount: Amount.from(1),
    unit: 'sat',
    state: 'pending',
    createdAt,
    updatedAt: createdAt,
  };
}

function historyManager() {
  const listeners = new Set<() => void>();
  const getPaginatedHistory = vi.fn();
  const on = vi.fn((_event: string, listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  return {
    manager: { history: { getPaginatedHistory }, on } as unknown as Manager,
    getPaginatedHistory,
    emit() {
      for (const listener of listeners) listener();
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

describe('usePaginatedHistory', () => {
  it('replaces the complete loaded infinite window on invalidation', async () => {
    const mock = historyManager();
    const first = [entry('b', 2), entry('a', 1)];
    const loaded = [entry('d', 4), entry('c', 3), ...first];
    const refreshed = [entry('e', 5), entry('d', 4), entry('c', 3), entry('b', 2)];
    mock.getPaginatedHistory
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(loaded)
      .mockResolvedValueOnce(refreshed);
    const { result } = renderHook(() => usePaginatedHistory(2), {
      wrapper: createHookWrapper(mock.manager),
    });
    await flush();

    await act(async () => result.current.loadMore());
    expect(mock.getPaginatedHistory).toHaveBeenNthCalledWith(2, 0, 4);
    expect(result.current.history).toEqual(loaded);
    act(() => mock.emit());
    await flush();
    expect(mock.getPaginatedHistory).toHaveBeenNthCalledWith(3, 0, 4);
    expect(result.current.history).toEqual(refreshed);
  });

  it('rereads only the current page in page mode', async () => {
    const mock = historyManager();
    const initial = [entry('b', 2), entry('a', 1)];
    const page = [entry('d', 4), entry('c', 3)];
    const refreshed = [entry('f', 6)];
    mock.getPaginatedHistory
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(refreshed);
    const { result } = renderHook(() => usePaginatedHistory(2), {
      wrapper: createHookWrapper(mock.manager),
    });
    await flush();
    await act(async () => result.current.goToPage(1));
    expect(mock.getPaginatedHistory).toHaveBeenNthCalledWith(2, 2, 2);
    act(() => mock.emit());
    await flush();
    expect(mock.getPaginatedHistory).toHaveBeenNthCalledWith(3, 2, 2);
    expect(result.current.history).toEqual(refreshed);
    expect(result.current.hasMore).toBe(false);
  });

  it('serializes foreground page changes and commits the newest requested page', async () => {
    const mock = historyManager();
    const initial = createDeferred<HistoryEntry[]>();
    const firstPage = createDeferred<HistoryEntry[]>();
    const secondPage = createDeferred<HistoryEntry[]>();
    const initialEntries = [entry('initial', 1)];
    const pageOneEntries = [entry('page-one', 2)];
    const pageTwoEntries = [entry('page-two', 3)];
    mock.getPaginatedHistory
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(secondPage.promise);
    const { result } = renderHook(() => usePaginatedHistory(2), {
      wrapper: createHookWrapper(mock.manager),
    });

    let pageOneRead!: Promise<void>;
    let pageTwoRead!: Promise<void>;
    act(() => {
      pageOneRead = result.current.goToPage(1);
      pageTwoRead = result.current.goToPage(2);
    });
    expect(mock.getPaginatedHistory).toHaveBeenCalledTimes(1);

    initial.resolve(initialEntries);
    await flush();
    expect(mock.getPaginatedHistory).toHaveBeenNthCalledWith(2, 2, 2);
    expect(mock.getPaginatedHistory).toHaveBeenCalledTimes(2);

    firstPage.resolve(pageOneEntries);
    await flush();
    expect(mock.getPaginatedHistory).toHaveBeenNthCalledWith(3, 4, 2);
    expect(mock.getPaginatedHistory).toHaveBeenCalledTimes(3);

    secondPage.resolve(pageTwoEntries);
    await act(async () => {
      await Promise.all([pageOneRead, pageTwoRead]);
    });
    expect(result.current.history).toEqual(pageTwoEntries);
  });

  it('runs a waiting foreground intent after the preceding read fails', async () => {
    const mock = historyManager();
    const failedPage = createDeferred<HistoryEntry[]>();
    const recoveredPage = [entry('recovered-page', 3)];
    mock.getPaginatedHistory
      .mockResolvedValueOnce([entry('initial', 1)])
      .mockReturnValueOnce(failedPage.promise)
      .mockResolvedValueOnce(recoveredPage);
    const { result } = renderHook(() => usePaginatedHistory(2), {
      wrapper: createHookWrapper(mock.manager),
    });
    await flush();

    let failedRead!: Promise<void>;
    let recoveredRead!: Promise<void>;
    act(() => {
      failedRead = result.current.goToPage(1);
      recoveredRead = result.current.goToPage(2);
    });

    await act(async () => {
      failedPage.reject(new Error('page one failed'));
      await expect(failedRead).rejects.toThrow('page one failed');
      await recoveredRead;
    });
    expect(mock.getPaginatedHistory).toHaveBeenNthCalledWith(3, 4, 2);
    expect(result.current.history).toEqual(recoveredPage);
  });

  it('runs one queued invalidation after an in-flight failure', async () => {
    const mock = historyManager();
    const pending = createDeferred<HistoryEntry[]>();
    const recovered = [entry('recovered', 1)];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mock.getPaginatedHistory.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(recovered);
    const { result } = renderHook(() => usePaginatedHistory(2), {
      wrapper: createHookWrapper(mock.manager),
    });
    act(() => mock.emit());
    pending.reject(new Error('temporary read failure'));
    await flush();
    await flush();

    expect(mock.getPaginatedHistory).toHaveBeenCalledTimes(2);
    expect(result.current.history).toEqual(recovered);
  });

  it('rejects explicit failures while retaining the last good data and cursor', async () => {
    const mock = historyManager();
    const initial = [entry('good', 1)];
    mock.getPaginatedHistory.mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error('bad'));
    const { result } = renderHook(() => usePaginatedHistory(2), {
      wrapper: createHookWrapper(mock.manager),
    });
    await flush();

    await expect(result.current.refresh()).rejects.toThrow('bad');
    expect(result.current.history).toEqual(initial);
    expect(result.current.hasMore).toBe(false);
  });

  it('fences an old Manager read and hydrates the replacement Manager', async () => {
    const first = historyManager();
    const second = historyManager();
    const oldRead = createDeferred<HistoryEntry[]>();
    const replacement = [entry('replacement', 2)];
    first.getPaginatedHistory.mockReturnValue(oldRead.promise);
    second.getPaginatedHistory.mockResolvedValue(replacement);
    let selectedManager = first.manager;
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <ManagerProvider manager={selectedManager}>{children}</ManagerProvider>
    );
    const { result, rerender } = renderHook(() => usePaginatedHistory(2), { wrapper: Wrapper });
    let queuedPageRead!: Promise<void>;
    act(() => {
      queuedPageRead = result.current.goToPage(3);
    });
    selectedManager = second.manager;
    rerender();
    await flush();
    expect(result.current.history).toEqual(replacement);
    expect(second.getPaginatedHistory).toHaveBeenCalledTimes(1);

    oldRead.resolve([entry('stale', 9)]);
    await act(async () => {
      await queuedPageRead;
    });
    expect(result.current.history).toEqual(replacement);
    expect(second.getPaginatedHistory).toHaveBeenCalledTimes(1);
  });

  it('drops a waiting page intent when the page size changes', async () => {
    const mock = historyManager();
    const oldRead = createDeferred<HistoryEntry[]>();
    const replacement = [entry('replacement', 2)];
    mock.getPaginatedHistory
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValueOnce(replacement);
    let selectedPageSize = 2;
    const { result, rerender } = renderHook(() => usePaginatedHistory(selectedPageSize), {
      wrapper: createHookWrapper(mock.manager),
    });
    let queuedPageRead!: Promise<void>;
    act(() => {
      queuedPageRead = result.current.goToPage(3);
    });

    selectedPageSize = 5;
    rerender();
    await flush();
    expect(mock.getPaginatedHistory).toHaveBeenNthCalledWith(2, 0, 5);
    expect(result.current.history).toEqual(replacement);

    oldRead.resolve([entry('stale', 9)]);
    await act(async () => {
      await queuedPageRead;
    });
    expect(mock.getPaginatedHistory).toHaveBeenCalledTimes(2);
    expect(result.current.history).toEqual(replacement);
  });

  it('does not dispatch a waiting page intent after unmount', async () => {
    const mock = historyManager();
    const oldRead = createDeferred<HistoryEntry[]>();
    mock.getPaginatedHistory.mockReturnValue(oldRead.promise);
    const { result, unmount } = renderHook(() => usePaginatedHistory(2), {
      wrapper: createHookWrapper(mock.manager),
    });
    let queuedPageRead!: Promise<void>;
    act(() => {
      queuedPageRead = result.current.goToPage(3);
    });

    unmount();
    oldRead.resolve([entry('stale', 9)]);
    await queuedPageRead;
    expect(mock.getPaginatedHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps one logical history listener under StrictMode', async () => {
    const mock = historyManager();
    mock.getPaginatedHistory.mockResolvedValue([]);
    const { unmount } = renderHook(() => usePaginatedHistory(2), {
      wrapper: createStrictHookWrapper(mock.manager),
    });
    await flush();
    expect(mock.listenerCount()).toBe(1);
    unmount();
    expect(mock.listenerCount()).toBe(0);
  });
});
