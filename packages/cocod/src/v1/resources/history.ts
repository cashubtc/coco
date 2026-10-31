import { parseHistoryEntryId, type HistoryEntry } from '@cashu/coco-core';

import type { V1Parameter } from '../contract.js';
import { noBodySchema } from '../schema.js';
import { historyPageSchema, historySchema, type HistoryDocument } from '../resource-schemas.js';
import { withCocoErrors } from './errors.js';
import {
  defineResourceRoute,
  fromMillis,
  notFound,
  pageParameters,
  requireRunningSession,
} from './shared.js';

/** Projects a history entry without tokens, payment requests, metadata, or error text. */
export function toHistoryDocument(entry: HistoryEntry): HistoryDocument {
  const operationId = entry.operationId?.trim();
  const quoteId = entry.type === 'mint' || entry.type === 'melt' ? entry.quoteId.trim() : '';
  return {
    id: entry.id,
    type: entry.type,
    source: entry.source,
    ...(operationId ? { operationId } : {}),
    ...(quoteId ? { quoteId } : {}),
    state: entry.state,
    mintUrl: entry.mintUrl,
    unit: entry.unit,
    amount: entry.amount.toString(),
    createdAt: fromMillis(entry.createdAt),
    updatedAt: fromMillis(entry.updatedAt),
  };
}

const historyEntryId: V1Parameter<string> = {
  in: 'path',
  required: true,
  description: 'History entry ID such as `send:{operationId}` or `legacy:{legacyHistoryId}`.',
  schema: { type: 'string', minLength: 1, maxLength: 512 },
  parse([value]) {
    if (!value || value.length > 512 || !parseHistoryEntryId(value)) {
      throw new Error('invalid history entry ID');
    }
    return value;
  },
};

export const historyRoutes = [
  defineResourceRoute({
    method: 'GET',
    path: '/v1/history',
    capability: 'wallet:read',
    summary: 'List Wallet history, newest first',
    requestSchema: noBodySchema,
    responseSchema: historyPageSchema,
    parameters: pageParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const entries = await withCocoErrors({ action: 'list Wallet history' }, () =>
        manager.history.getPaginatedHistory(params.offset, params.limit),
      );
      return { items: entries.map(toHistoryDocument), offset: params.offset, limit: params.limit };
    },
  }),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/history/{historyEntryId}',
    capability: 'wallet:read',
    summary: 'Read a Wallet history entry',
    requestSchema: noBodySchema,
    responseSchema: historySchema,
    parameters: { historyEntryId },
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const entry = await withCocoErrors({ action: 'read the Wallet history entry' }, () =>
        manager.history.getHistoryEntryById(params.historyEntryId),
      );
      if (!entry) throw notFound('The Wallet history entry does not exist');
      return toHistoryDocument(entry);
    },
  }),
];
