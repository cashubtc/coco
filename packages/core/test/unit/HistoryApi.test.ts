import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { HistoryApi } from '../../api/HistoryApi';
import type { HistoryEntry } from '../../models/History';
import type { HistoryService } from '../../services';

describe('HistoryApi', () => {
  let api: HistoryApi;
  let historyService: HistoryService;

  beforeEach(() => {
    historyService = {
      getPaginatedHistory: mock(async () => []),
      getHistoryEntryById: mock(async () => null),
    } as unknown as HistoryService;

    api = new HistoryApi(historyService);
  });

  it('delegates operationId lookups to the history service', async () => {
    (
      historyService.getHistoryEntryById as unknown as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      id: 'history-1',
      type: 'melt',
      mintUrl: 'https://mint.test',
      quoteId: 'quote-1',
      operationId: 'operation-1',
      amount: 10,
      state: 'UNPAID',
      unit: 'sat',
      createdAt: Date.now(),
    } as HistoryEntry);

    await expect(api.getOperationIdForHistoryEntry('history-1')).resolves.toBe('operation-1');
    expect(historyService.getHistoryEntryById).toHaveBeenCalledWith('history-1');
  });

  it('preserves null operationId lookups from the history service', async () => {
    await expect(api.getOperationIdForHistoryEntry('history-2')).resolves.toBeNull();
    expect(historyService.getHistoryEntryById).toHaveBeenCalledWith('history-2');
  });
});
