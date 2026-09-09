import { parseHistoryEntryId } from '@cashu/coco-core';
import {
  defineV1Route,
  V1HttpError,
  type V1Runtime,
  type V1RouteDefinition,
  type V1RouteMetadata,
} from '../contract.js';
import {
  historyPageSchema,
  historySchema,
  noBodySchema,
  type HistoryDocument,
  type HistoryPageDocument,
} from '../schema.js';
import { requireRunningSession } from './session.js';
import {
  parseQuery,
  invalidQuery,
  queryParameterNames,
  PAGE_PARAMETERS,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
  parsePageInteger,
  pathParameter,
  parsePathIdentity,
} from './parameters.js';
import { toHistoryDocument } from './history-projection.js';

const LIST_HISTORY_ROUTE = {
  method: 'GET',
  path: '/v1/history',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: historyPageSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: PAGE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, HistoryPageDocument>;

const GET_HISTORY_ROUTE = {
  method: 'GET',
  path: '/v1/history/{historyEntryId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: historySchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [pathParameter('historyEntryId')],
} as const satisfies V1RouteMetadata<null, HistoryDocument>;

function parseHistoryPageQuery(request: Request): { offset: number; limit: number } {
  const message = 'The Wallet history pagination is invalid';
  const query = parseQuery(request, queryParameterNames(LIST_HISTORY_ROUTE.parameters), message);
  return {
    offset: parsePageInteger(query.getAll('offset'), 0, Number.MAX_SAFE_INTEGER, 0, message),
    limit: parsePageInteger(query.getAll('limit'), 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, message),
  };
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

export const historyMetadata = [LIST_HISTORY_ROUTE, GET_HISTORY_ROUTE];

export function createHistoryRoutes(runtime: V1Runtime): V1RouteDefinition[] {
  const listHistory = defineV1Route({
    ...LIST_HISTORY_ROUTE,
    handler: async (_input, request) => {
      const history = requireRunningSession(runtime).manager.history;
      const { offset, limit } = parseHistoryPageQuery(request);
      try {
        const entries = await history.getPaginatedHistory(offset, limit);
        return { items: entries.map(toHistoryDocument), offset, limit };
      } catch (error) {
        throw historyCocoError('list Wallet history', error);
      }
    },
  });
  const getHistory = defineV1Route({
    ...GET_HISTORY_ROUTE,
    handler: async (_input, request) => {
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
  });
  return [listHistory, getHistory];
}
