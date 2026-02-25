import type { HistoryEntry } from 'coco-cashu-core';
import { getManagerContext } from '../context.js';
import { onMount, onDestroy } from 'svelte';

/**
 * Reactive paginated history composable.
 *
 * Supports both infinite-scroll (`loadMore()`) and page-based (`goToPage()`) modes.
 * Automatically refreshes when the manager emits `history:updated`.
 */
export function usePaginatedHistory(pageSize = 100) {
  const manager = getManagerContext();

  let history = $state<HistoryEntry[]>([]);
  let isFetching = $state(false);
  let hasMore = $state(true);

  let start = 0;
  let mode: 'infinite' | 'page' = 'infinite';
  let fetchingGuard = false;

  function setFetching(value: boolean) {
    fetchingGuard = value;
    isFetching = value;
  }

  async function fetchPage(offset: number): Promise<HistoryEntry[]> {
    try {
      const page = await manager.history.getPaginatedHistory(offset, pageSize);
      return page || [];
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  async function refresh() {
    if (fetchingGuard) return;
    setFetching(true);
    try {
      if (mode === 'infinite' && start === 0) {
        const top = await fetchPage(0);
        const topIds: Record<string, true> = {};
        for (const t of top) topIds[t.id] = true;
        history = [...top, ...history.filter((e) => !topIds[e.id])];
      } else {
        history = await fetchPage(start);
      }
    } finally {
      setFetching(false);
    }
  }

  async function loadMore() {
    if (!hasMore || fetchingGuard) return;
    setFetching(true);
    mode = 'infinite';
    const nextStart = start + pageSize;
    const page = await fetchPage(nextStart);
    hasMore = page.length === pageSize;

    const seen: Record<string, true> = {};
    const merged: HistoryEntry[] = [];
    for (const entry of [...history, ...page]) {
      if (seen[entry.id]) continue;
      seen[entry.id] = true;
      merged.push(entry);
    }
    history = merged;
    start = nextStart;
    setFetching(false);
  }

  async function goToPage(pageNumber: number) {
    const offset = pageNumber * pageSize;
    if (fetchingGuard) return;
    setFetching(true);
    mode = 'page';
    const data = await fetchPage(offset);
    hasMore = data.length === pageSize;
    history = data;
    start = offset;
    setFetching(false);
  }

  // Initial load
  onMount(async () => {
    if (fetchingGuard) return;
    setFetching(true);
    mode = 'infinite';
    start = 0;
    const page = await fetchPage(0);
    hasMore = page.length === pageSize;
    history = page;
    setFetching(false);
  });

  // Auto-refresh on history events
  const handler = () => {
    void refresh();
  };
  manager.on('history:updated', handler);
  onDestroy(() => {
    manager.off('history:updated', handler);
  });

  return {
    get history() {
      return history;
    },
    get isFetching() {
      return isFetching;
    },
    get hasMore() {
      return hasMore;
    },
    loadMore,
    goToPage,
    refresh,
  };
}
