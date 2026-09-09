import { parseHistoryEntryId } from '@cashu/coco-core';
import { V1HttpError } from '../contract.js';
import { defineResourceRoute } from '../resource.js';
import { historyPageSchema, historySchema, noBodySchema } from '../schema.js';
import { toHistoryDocument } from './history-projection.js';
import {
  invalidQuery,
  PAGE_PARAMETERS,
  parsePageQuery,
  parsePathIdentity,
  parseQuery,
  pathParameter,
} from './parameters.js';
import { requireRunningSession } from './session.js';

function parseHistoryPageQuery(request: Request): { offset: number; limit: number } {
  const message = 'The Wallet history pagination is invalid';
  return parsePageQuery(request, message);
}

function parseHistoryEntryIdPath(request: Request): string {
  const message = 'The Wallet history entry identity is invalid';
  parseQuery(request, [], message);
  const id = parsePathIdentity(request, '/v1/history/', '', message);
  if (!parseHistoryEntryId(id)) throw invalidQuery(message);
  return id;
}

function historyCocoError(action: string, cause: unknown): V1HttpError {
  return new V1HttpError({
    status: 500,
    code: 'coco_error',
    message: `Coco could not ${action}`,
    retryable: false,
    cause,
  });
}

function historyNotFound(): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Wallet history entry does not exist',
    retryable: false,
  });
}

export const historyRoutes = [
  defineResourceRoute({
    method: 'GET',
    path: '/v1/history',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: historyPageSchema,
    parameters: PAGE_PARAMETERS,
    handler: async (_input, request, { runtime }) => {
      const history = requireRunningSession(runtime).manager.history;
      const { offset, limit } = parseHistoryPageQuery(request);
      try {
        const entries = await history.getPaginatedHistory(offset, limit);
        return { items: entries.map(toHistoryDocument), offset, limit };
      } catch (error) {
        throw historyCocoError('list Wallet history', error);
      }
    },
  }),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/history/{historyEntryId}',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: historySchema,
    parameters: [pathParameter('historyEntryId')],
    handler: async (_input, request, { runtime }) => {
      const history = requireRunningSession(runtime).manager.history;
      const historyEntryId = parseHistoryEntryIdPath(request);
      try {
        const entry = await history.getHistoryEntryById(historyEntryId);
        if (!entry) throw historyNotFound();
        return toHistoryDocument(entry);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw historyCocoError('return the Wallet history entry', error);
      }
    },
  }),
];
