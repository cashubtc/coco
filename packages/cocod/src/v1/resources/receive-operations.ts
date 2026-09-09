import {
  normalizeMintUrl,
  ReceiveOperationNotFoundError,
  ReceiveOperationStateError,
  type ReceiveOperation,
} from '@cashu/coco-core';
import {
  defineV1Route,
  V1HttpError,
  V1HttpResponse,
  type V1Runtime,
  type V1RouteDefinition,
  type V1RouteMetadata,
} from '../contract.js';
import {
  createReceiveOperationRequestSchema,
  noSuccessResponseSchema,
  noBodySchema,
  receiveOperationSchema,
  receiveOperationsSchema,
  type CreateReceiveOperationRequest,
  type ReceiveOperationDocument,
  type ReceiveOperationsDocument,
} from '../schema.js';
import { requireRunningSession } from './session.js';
import {
  parseQuery,
  queryParameterNames,
  PAGE_PARAMETERS,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
  parsePageInteger,
  pathParameter,
  parsePathIdentity,
  compareOperationsForPagination,
} from './parameters.js';
import { createOperationCocoErrorMapper } from './errors.js';

const CREATE_RECEIVE_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/receive',
  capability: 'wallet:admin',
  requestSchema: createReceiveOperationRequestSchema,
  responseSchema: receiveOperationSchema,
  successStatuses: [201],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<CreateReceiveOperationRequest, ReceiveOperationDocument>;

const GET_RECEIVE_OPERATION_ROUTE = {
  method: 'GET',
  path: '/v1/operations/receive/{operationId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: receiveOperationSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, ReceiveOperationDocument>;

const LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE = {
  method: 'GET',
  path: '/v1/operations/receive/prepared',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: receiveOperationsSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: PAGE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, ReceiveOperationsDocument>;

const LIST_IN_FLIGHT_RECEIVE_OPERATIONS_ROUTE = {
  ...LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE,
  path: '/v1/operations/receive/in-flight',
} as const satisfies V1RouteMetadata<null, ReceiveOperationsDocument>;

const EXECUTE_RECEIVE_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/receive/{operationId}/execute',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: receiveOperationSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, ReceiveOperationDocument>;

const GET_RECEIVE_OPERATION_RESULT_ROUTE = {
  method: 'GET',
  path: '/v1/operations/receive/{operationId}/result',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: noSuccessResponseSchema,
  successStatuses: [],
  idempotencyKey: null,
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, never>;

const CANCEL_RECEIVE_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/receive/{operationId}/cancel',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: receiveOperationSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, ReceiveOperationDocument>;

const REFRESH_RECEIVE_OPERATION_ROUTE = {
  ...CANCEL_RECEIVE_OPERATION_ROUTE,
  path: '/v1/operations/receive/{operationId}/refresh',
} as const satisfies V1RouteMetadata<null, ReceiveOperationDocument>;

function toReceiveOperationDocument(operation: ReceiveOperation): ReceiveOperationDocument {
  const base = {
    id: operation.id,
    type: 'receive' as const,
    mintUrl: normalizeMintUrl(operation.mintUrl),
    unit: operation.unit,
    amount: operation.amount.toString(),
    createdAt: new Date(operation.createdAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
  };
  if (operation.state === 'init') return { ...base, state: operation.state };
  return { ...base, state: operation.state, fee: operation.fee.toString() };
}

function parseReceiveOperationPageQuery(
  request: Request,
  kind: 'prepared' | 'in-flight',
): { offset: number; limit: number } {
  const message = `The ${kind} Receive Operation filters are invalid`;
  const route =
    kind === 'prepared'
      ? LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE
      : LIST_IN_FLIGHT_RECEIVE_OPERATIONS_ROUTE;
  const query = parseQuery(request, queryParameterNames(route.parameters), message);
  return {
    offset: parsePageInteger(query.getAll('offset'), 0, Number.MAX_SAFE_INTEGER, 0, message),
    limit: parsePageInteger(query.getAll('limit'), 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, message),
  };
}

const receiveOperationCocoError = createOperationCocoErrorMapper({
  type: 'receive',
  label: 'Receive',
  notFoundError: ReceiveOperationNotFoundError,
  stateError: ReceiveOperationStateError,
  notFound: receiveOperationNotFound,
});

function receiveOperationNotFound(cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Receive Operation does not exist',
    retryable: false,
    cause,
  });
}

function parseReceiveOperationId(request: Request, command?: string): string {
  const message = 'The Receive Operation identity is invalid';
  parseQuery(request, [], message);
  return parsePathIdentity(
    request,
    '/v1/operations/receive/',
    command ? `/${command}` : '',
    message,
  );
}

export const receiveOperationsMetadata = [
  CREATE_RECEIVE_OPERATION_ROUTE,
  LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE,
  LIST_IN_FLIGHT_RECEIVE_OPERATIONS_ROUTE,
  GET_RECEIVE_OPERATION_ROUTE,
  EXECUTE_RECEIVE_OPERATION_ROUTE,
  GET_RECEIVE_OPERATION_RESULT_ROUTE,
  CANCEL_RECEIVE_OPERATION_ROUTE,
  REFRESH_RECEIVE_OPERATION_ROUTE,
];

export function createReceiveOperationsRoutes(runtime: V1Runtime): V1RouteDefinition[] {
  const createReceiveOperation = defineV1Route({
    ...CREATE_RECEIVE_OPERATION_ROUTE,
    handler: async (input) => {
      const receive = requireRunningSession(runtime).manager.ops.receive;
      try {
        const operation = await receive.prepare({ token: input.token });
        return new V1HttpResponse(toReceiveOperationDocument(operation), 201);
      } catch (error) {
        throw receiveOperationCocoError('prepare the Receive Operation', error);
      }
    },
  });
  const getReceiveOperation = defineV1Route({
    ...GET_RECEIVE_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const receive = requireRunningSession(runtime).manager.ops.receive;
      const operationId = parseReceiveOperationId(request);
      try {
        const operation = await receive.get(operationId);
        if (!operation) throw receiveOperationNotFound();
        return toReceiveOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw receiveOperationCocoError('return the Receive Operation', error);
      }
    },
  });
  const listReceiveOperations = (
    route:
      | typeof LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE
      | typeof LIST_IN_FLIGHT_RECEIVE_OPERATIONS_ROUTE,
    kind: 'prepared' | 'in-flight',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const receive = requireRunningSession(runtime).manager.ops.receive;
        const { offset, limit } = parseReceiveOperationPageQuery(request, kind);
        try {
          const operations =
            kind === 'prepared' ? await receive.listPrepared() : await receive.listInFlight();
          return {
            items: operations
              .toSorted(compareOperationsForPagination)
              .slice(offset, offset + limit)
              .map(toReceiveOperationDocument),
            offset,
            limit,
          };
        } catch (error) {
          throw receiveOperationCocoError(`list ${kind} Receive Operations`, error);
        }
      },
    });
  const listPreparedReceiveOperations = listReceiveOperations(
    LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE,
    'prepared',
  );
  const listInFlightReceiveOperations = listReceiveOperations(
    LIST_IN_FLIGHT_RECEIVE_OPERATIONS_ROUTE,
    'in-flight',
  );
  const executeReceiveOperation = defineV1Route({
    ...EXECUTE_RECEIVE_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const receive = requireRunningSession(runtime).manager.ops.receive;
      const operationId = parseReceiveOperationId(request, 'execute');
      try {
        return toReceiveOperationDocument(await receive.execute(operationId));
      } catch (error) {
        throw receiveOperationCocoError('execute the Receive Operation', error);
      }
    },
  });
  const getReceiveOperationResult = defineV1Route({
    ...GET_RECEIVE_OPERATION_RESULT_ROUTE,
    handler: async (_input, request) => {
      requireRunningSession(runtime);
      parseReceiveOperationId(request, 'result');
      throw new V1HttpError({
        status: 404,
        code: 'not_found',
        message: 'Receive Operations do not expose a distinct result',
        retryable: false,
      });
    },
  });
  const receiveOperationCommand = (
    route: typeof CANCEL_RECEIVE_OPERATION_ROUTE | typeof REFRESH_RECEIVE_OPERATION_ROUTE,
    command: 'cancel' | 'refresh',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const receive = requireRunningSession(runtime).manager.ops.receive;
        const operationId = parseReceiveOperationId(request, command);
        try {
          await receive[command](operationId);
          const operation = await receive.get(operationId);
          if (!operation) throw receiveOperationNotFound();
          return toReceiveOperationDocument(operation);
        } catch (error) {
          if (error instanceof V1HttpError) throw error;
          throw receiveOperationCocoError(`${command} the Receive Operation`, error);
        }
      },
    });
  const cancelReceiveOperation = receiveOperationCommand(CANCEL_RECEIVE_OPERATION_ROUTE, 'cancel');
  const refreshReceiveOperation = receiveOperationCommand(
    REFRESH_RECEIVE_OPERATION_ROUTE,
    'refresh',
  );
  return [
    createReceiveOperation,
    listPreparedReceiveOperations,
    listInFlightReceiveOperations,
    getReceiveOperation,
    executeReceiveOperation,
    getReceiveOperationResult,
    cancelReceiveOperation,
    refreshReceiveOperation,
  ];
}
