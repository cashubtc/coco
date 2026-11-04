import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry } from '@cashu/coco-core';
import { useManager } from '../contexts/ManagerContext';

export type UsePaginatedHistoryResult = {
  history: HistoryEntry[];
  loadMore: () => Promise<void>;
  goToPage: (page: number) => Promise<void>;
  refresh: () => Promise<void>;
  hasMore: boolean;
  isFetching: boolean;
};

type Cursor = { mode: 'infinite' | 'page'; start: number };
type ReadIntent = Cursor & { background: boolean };

export const usePaginatedHistory = (pageSize = 100): UsePaginatedHistoryResult => {
  const manager = useManager();
  const managerRef = useRef(manager);
  const pageSizeRef = useRef(pageSize);
  const generationRef = useRef(0);
  const cursorRef = useRef<Cursor>({ mode: 'infinite', start: 0 });
  const fetchingRef = useRef(false);
  const queuedInvalidationRef = useRef(false);
  const activeReadRef = useRef<Promise<void> | null>(null);
  const runReadRef = useRef<(intent: ReadIntent) => Promise<void>>(async () => {});

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [isFetching, setIsFetching] = useState(false);

  const runRead = useCallback(async (intent: ReadIntent): Promise<void> => {
    const generation = generationRef.current;
    const selectedManager = managerRef.current;
    const selectedPageSize = pageSizeRef.current;

    while (fetchingRef.current) {
      if (intent.background) {
        queuedInvalidationRef.current = true;
        return activeReadRef.current ?? Promise.resolve();
      }

      try {
        await (activeReadRef.current ?? Promise.resolve());
      } catch {
        // The caller that started the failed read receives its error. A later foreground intent
        // still needs to run rather than inheriting that failure.
      }
    }

    if (
      generation !== generationRef.current ||
      selectedManager !== managerRef.current ||
      selectedPageSize !== pageSizeRef.current
    ) {
      return;
    }

    const offset = intent.mode === 'infinite' ? 0 : intent.start;
    const limit = intent.mode === 'infinite' ? intent.start + selectedPageSize : selectedPageSize;
    fetchingRef.current = true;
    setIsFetching(true);

    const read = (async () => {
      try {
        const entries = (await selectedManager.history.getPaginatedHistory(offset, limit)) ?? [];
        if (generation !== generationRef.current || selectedManager !== managerRef.current) return;
        cursorRef.current = { mode: intent.mode, start: intent.start };
        setHistory(entries);
        setHasMore(entries.length === limit);
      } catch (readError) {
        if (intent.background) {
          console.error(readError);
          return;
        }
        throw readError;
      } finally {
        if (generation === generationRef.current && selectedManager === managerRef.current) {
          fetchingRef.current = false;
          setIsFetching(false);
          activeReadRef.current = null;
          if (queuedInvalidationRef.current) {
            queuedInvalidationRef.current = false;
            const cursor = cursorRef.current;
            void runReadRef.current({ ...cursor, background: true });
          }
        }
      }
    })();
    activeReadRef.current = read;
    return read;
  }, []);

  runReadRef.current = runRead;

  useEffect(() => {
    managerRef.current = manager;
    pageSizeRef.current = pageSize;
    generationRef.current += 1;
    cursorRef.current = { mode: 'infinite', start: 0 };
    fetchingRef.current = false;
    queuedInvalidationRef.current = false;
    activeReadRef.current = null;
    setHistory([]);
    setHasMore(true);
    setIsFetching(false);

    const generation = generationRef.current;
    const unsubscribe = manager.on('history:updated', () => {
      if (generation !== generationRef.current) return;
      if (fetchingRef.current) {
        queuedInvalidationRef.current = true;
        return;
      }
      void runReadRef.current({ ...cursorRef.current, background: true });
    });
    void runReadRef.current({ mode: 'infinite', start: 0, background: true });

    return () => {
      unsubscribe();
      generationRef.current += 1;
      fetchingRef.current = false;
      queuedInvalidationRef.current = false;
      activeReadRef.current = null;
    };
  }, [manager, pageSize]);

  const refresh = useCallback(async () => {
    await runReadRef.current({ ...cursorRef.current, background: false });
  }, []);

  const loadMore = useCallback(async () => {
    if (!hasMore) return;
    const start =
      cursorRef.current.mode === 'infinite' ? cursorRef.current.start + pageSizeRef.current : 0;
    await runReadRef.current({ mode: 'infinite', start, background: false });
  }, [hasMore]);

  const goToPage = useCallback(async (page: number) => {
    if (!Number.isSafeInteger(page) || page < 0) {
      throw new TypeError('History page must be a nonnegative safe integer');
    }
    await runReadRef.current({
      mode: 'page',
      start: page * pageSizeRef.current,
      background: false,
    });
  }, []);

  return useMemo(
    () => ({ history, loadMore, goToPage, refresh, hasMore, isFetching }),
    [goToPage, hasMore, history, isFetching, loadMore, refresh],
  );
};
