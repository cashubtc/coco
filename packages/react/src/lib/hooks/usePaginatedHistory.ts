import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry } from 'coco-cashu-core';
import { useManager } from '../contexts/ManagerContext';

export type UsePaginatedHistoryResult = {
  history: HistoryEntry[];
  loadMore: () => Promise<void>;
  goToPage: (page: number) => Promise<void>;
  refresh: () => Promise<void>;
  hasMore: boolean;
  isFetching: boolean;
};

export const usePaginatedHistory = (pageSize = 100): UsePaginatedHistoryResult => {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const manager = useManager();

  const startRef = useRef(0);
  const hasMoreRef = useRef(true);
  const modeRef = useRef<'infinite' | 'page'>('infinite');
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchPage = useCallback(
    async (offset: number): Promise<HistoryEntry[]> => {
      try {
        const page = await manager.history.getPaginatedHistory(offset, pageSize);
        return page || [];
      } catch (error) {
        console.error(error);
        return [];
      }
    },
    [manager, pageSize],
  );

  const init = useCallback(async () => {
    if (isFetching) return;
    setIsFetching(true);
    modeRef.current = 'infinite';
    startRef.current = 0;
    const page = await fetchPage(0);
    hasMoreRef.current = page.length === pageSize;
    if (isMountedRef.current) setHistory(page);
    setIsFetching(false);
  }, [fetchPage, pageSize, isFetching]);

  const refresh = useCallback(async () => {
    if (isFetching) return;
    setIsFetching(true);
    try {
      if (modeRef.current === 'infinite' && startRef.current === 0) {
        const top = await fetchPage(0);
        if (!isMountedRef.current) return;
        setHistory((prev) => {
          const withoutTop = prev.filter((e) => !top.some((t) => t.id === e.id));
          return [...top, ...withoutTop];
        });
      } else {
        const page = await fetchPage(startRef.current);
        if (!isMountedRef.current) return;
        setHistory(page);
      }
    } finally {
      setIsFetching(false);
    }
  }, [fetchPage, isFetching]);

  useEffect(() => {
    init();
    manager.on('history:updated', refresh);
    return () => {
      manager.off('history:updated', refresh);
    };
  }, [manager, init, refresh]);

  const loadMore = useCallback(async () => {
    if (!hasMoreRef.current || isFetching) return;
    setIsFetching(true);
    modeRef.current = 'infinite';
    const nextStart = startRef.current + pageSize;
    const page = await fetchPage(nextStart);
    hasMoreRef.current = page.length === pageSize;
    if (isMountedRef.current) {
      setHistory((prev) => {
        const seen = new Set<string>();
        const merged: HistoryEntry[] = [];
        for (const entry of [...prev, ...page]) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          merged.push(entry);
        }
        return merged;
      });
      startRef.current = nextStart;
    }
    setIsFetching(false);
  }, [fetchPage, pageSize, isFetching]);

  const goToPage = useCallback(
    async (pageNumber: number) => {
      const offset = pageNumber * pageSize;
      if (isFetching) return;
      setIsFetching(true);
      modeRef.current = 'page';
      const data = await fetchPage(offset);
      hasMoreRef.current = data.length === pageSize;
      if (isMountedRef.current) {
        setHistory(data);
        startRef.current = offset;
      }
      setIsFetching(false);
    },
    [fetchPage, pageSize, isFetching],
  );

  return useMemo(
    () => ({
      history,
      loadMore,
      goToPage,
      refresh,
      hasMore: hasMoreRef.current,
      isFetching,
    }),
    [history, loadMore, goToPage, refresh, isFetching],
  );
};
