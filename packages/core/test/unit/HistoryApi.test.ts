import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { HistoryApi } from '../../api/HistoryApi';
import type { HistoryEntry, LegacyHistoryEntry } from '../../models/History';
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

  const operationEntry = {
    id: 'history-1',
    source: 'operation' as const,
    mintUrl: 'https://mint.test',
    operationId: '  operation-1  ',
    amount: Amount.from(10),
    state: 'finalized' as const,
    unit: 'sat',
    createdAt: 1,
    updatedAt: 2,
  };
  const operationEntries: HistoryEntry[] = [
    { ...operationEntry, type: 'send' },
    { ...operationEntry, type: 'receive' },
    { ...operationEntry, type: 'melt', quoteId: 'quote-1' },
    { ...operationEntry, type: 'mint', quoteId: 'quote-1', paymentRequest: 'lnbc10' },
  ];

  it.each(operationEntries)('returns trimmed operation IDs for $type history', async (entry) => {
    (
      historyService.getHistoryEntryById as unknown as ReturnType<typeof mock>
    ).mockResolvedValueOnce(entry);

    await expect(api.getOperationIdForHistoryEntry(entry.id)).resolves.toBe('operation-1');
    expect(historyService.getHistoryEntryById).toHaveBeenCalledWith(entry.id);
  });

  it('returns null for legacy history without an operation ID', async () => {
    const entry = {
      id: 'legacy:1',
      source: 'legacy',
      legacyHistoryId: '1',
      type: 'send',
      mintUrl: 'https://mint.test',
      amount: Amount.from(10),
      state: 'pending',
      unit: 'sat',
      createdAt: 1,
      updatedAt: 1,
    } satisfies LegacyHistoryEntry;
    (
      historyService.getHistoryEntryById as unknown as ReturnType<typeof mock>
    ).mockResolvedValueOnce(entry);

    await expect(api.getOperationIdForHistoryEntry(entry.id)).resolves.toBeNull();
  });

  it('preserves null operationId lookups from the history service', async () => {
    await expect(api.getOperationIdForHistoryEntry('history-2')).resolves.toBeNull();
    expect(historyService.getHistoryEntryById).toHaveBeenCalledWith('history-2');
  });

  it('normalizes blank operationId lookups from the history service to null', async () => {
    (
      historyService.getHistoryEntryById as unknown as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      id: 'history-3',
      source: 'operation',
      type: 'send',
      mintUrl: 'https://mint.test',
      operationId: '   ',
      amount: Amount.from(10),
      state: 'pending',
      unit: 'sat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as HistoryEntry);

    await expect(api.getOperationIdForHistoryEntry('history-3')).resolves.toBeNull();
    expect(historyService.getHistoryEntryById).toHaveBeenCalledWith('history-3');
  });
});
