import { normalizeMintUrl, type HistoryEntry } from '@cashu/coco-core';
import { type HistoryDocument } from '../schema.js';

export function toHistoryDocument(entry: HistoryEntry): HistoryDocument {
  const operationId = entry.operationId?.trim();
  const base = {
    id: entry.id,
    source: entry.source,
    ...(operationId ? { operationId } : {}),
    state: entry.state,
    mintUrl: normalizeMintUrl(entry.mintUrl),
    unit: entry.unit,
    amount: entry.amount.toString(),
    createdAt: new Date(entry.createdAt).toISOString(),
    updatedAt: new Date(entry.updatedAt).toISOString(),
  };

  switch (entry.type) {
    case 'mint':
    case 'melt':
      return {
        ...base,
        type: entry.type,
        ...(entry.quoteId.trim() ? { quoteId: entry.quoteId } : {}),
      };
    case 'send':
      return { ...base, type: entry.type };
    case 'receive':
      return { ...base, type: entry.type };
  }
}
