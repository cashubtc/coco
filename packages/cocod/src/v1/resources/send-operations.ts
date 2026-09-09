import {
  normalizeMintUrl,
  SendOperationNotFoundError,
  SendOperationStateError,
  type SendOperation,
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
  createSendOperationRequestSchema,
  executeSendOperationResponseSchema,
  noBodySchema,
  sendOperationSchema,
  sendOperationsSchema,
  sendResultSchema,
  type CreateSendOperationRequest,
  type ExecuteSendOperationResponseDocument,
  type SendOperationDocument,
  type SendOperationsDocument,
  type SendResultDocument,
} from '../schema.js';
import { requireRunningSession, type RunningSession } from './session.js';
import { paymentRequestCocoError, createOperationCocoErrorMapper } from './errors.js';
import {
  parseQuery,
  queryParameterNames,
  PAGE_PARAMETERS,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
  parsePageInteger,
  pathParameter,
  parsePathIdentity,
  parseMintUrl,
  compareOperationsForPagination,
} from './parameters.js';

const CREATE_SEND_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/send',
  capability: 'wallet:admin',
  requestSchema: createSendOperationRequestSchema,
  responseSchema: sendOperationSchema,
  successStatuses: [201],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<CreateSendOperationRequest, SendOperationDocument>;

const GET_SEND_OPERATION_ROUTE = {
  method: 'GET',
  path: '/v1/operations/send/{operationId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: sendOperationSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, SendOperationDocument>;

const LIST_PREPARED_SEND_OPERATIONS_ROUTE = {
  method: 'GET',
  path: '/v1/operations/send/prepared',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: sendOperationsSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: PAGE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, SendOperationsDocument>;

const LIST_IN_FLIGHT_SEND_OPERATIONS_ROUTE = {
  ...LIST_PREPARED_SEND_OPERATIONS_ROUTE,
  path: '/v1/operations/send/in-flight',
} as const satisfies V1RouteMetadata<null, SendOperationsDocument>;

const EXECUTE_SEND_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/send/{operationId}/execute',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: executeSendOperationResponseSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, ExecuteSendOperationResponseDocument>;

const GET_SEND_OPERATION_RESULT_ROUTE = {
  method: 'GET',
  path: '/v1/operations/send/{operationId}/result',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: sendResultSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, SendResultDocument>;

const CANCEL_SEND_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/send/{operationId}/cancel',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: sendOperationSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, SendOperationDocument>;

const REFRESH_SEND_OPERATION_ROUTE = {
  ...CANCEL_SEND_OPERATION_ROUTE,
  path: '/v1/operations/send/{operationId}/refresh',
} as const satisfies V1RouteMetadata<null, SendOperationDocument>;

const RECLAIM_SEND_OPERATION_ROUTE = {
  ...CANCEL_SEND_OPERATION_ROUTE,
  path: '/v1/operations/send/{operationId}/reclaim',
} as const satisfies V1RouteMetadata<null, SendOperationDocument>;

async function preparePaymentRequestSend(
  session: RunningSession,
  input: Extract<CreateSendOperationRequest, { source: unknown }>,
  mintUrl: string,
): Promise<SendOperation> {
  const resolved = await session.manager.paymentRequests.parse(input.source.request);
  if (resolved.transport.type !== 'inband') {
    throw new V1HttpError({
      status: 409,
      code: 'unsupported_behavior',
      message: 'Payment Request delivery is unsupported for this transport',
      retryable: false,
      details: { transport: resolved.transport.type },
    });
  }
  const amount =
    !('amount' in input) || input.amount === undefined
      ? undefined
      : input.unit === undefined
        ? input.amount
        : { amount: input.amount, unit: input.unit };
  const prepared = await session.manager.paymentRequests.prepare(resolved, {
    mintUrl,
    ...(amount !== undefined ? { amount } : {}),
  });
  return prepared.sendOperation;
}

function toSendOperationDocument(operation: SendOperation): SendOperationDocument {
  const base = {
    id: operation.id,
    type: 'send' as const,
    mintUrl: normalizeMintUrl(operation.mintUrl),
    unit: operation.unit,
    method: operation.method,
    requestedAmount: operation.amount.toString(),
    createdAt: new Date(operation.createdAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
  };
  if (operation.state === 'init') return { ...base, state: operation.state };
  return {
    ...base,
    state: operation.state,
    inputAmount: operation.inputAmount.toString(),
    fee: operation.fee.toString(),
    needsSwap: operation.needsSwap,
  };
}

function parseSendOperationPageQuery(
  request: Request,
  kind: 'prepared' | 'in-flight',
): { offset: number; limit: number } {
  const message = `The ${kind} Send Operation filters are invalid`;
  const route =
    kind === 'prepared'
      ? LIST_PREPARED_SEND_OPERATIONS_ROUTE
      : LIST_IN_FLIGHT_SEND_OPERATIONS_ROUTE;
  const query = parseQuery(request, queryParameterNames(route.parameters), message);
  return {
    offset: parsePageInteger(query.getAll('offset'), 0, Number.MAX_SAFE_INTEGER, 0, message),
    limit: parsePageInteger(query.getAll('limit'), 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, message),
  };
}

const sendOperationCocoError = createOperationCocoErrorMapper({
  type: 'send',
  label: 'Send',
  notFoundError: SendOperationNotFoundError,
  stateError: SendOperationStateError,
  notFound: sendOperationNotFound,
});

function sendOperationNotFound(cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Send Operation does not exist',
    retryable: false,
    cause,
  });
}

function parseSendOperationId(request: Request, command?: string): string {
  const message = 'The Send Operation identity is invalid';
  parseQuery(request, [], message);
  return parsePathIdentity(request, '/v1/operations/send/', command ? `/${command}` : '', message);
}

export const sendOperationsMetadata = [
  CREATE_SEND_OPERATION_ROUTE,
  LIST_PREPARED_SEND_OPERATIONS_ROUTE,
  LIST_IN_FLIGHT_SEND_OPERATIONS_ROUTE,
  GET_SEND_OPERATION_ROUTE,
  EXECUTE_SEND_OPERATION_ROUTE,
  GET_SEND_OPERATION_RESULT_ROUTE,
  CANCEL_SEND_OPERATION_ROUTE,
  REFRESH_SEND_OPERATION_ROUTE,
  RECLAIM_SEND_OPERATION_ROUTE,
];

export function createSendOperationsRoutes(runtime: V1Runtime): V1RouteDefinition[] {
  const createSendOperation = defineV1Route({
    ...CREATE_SEND_OPERATION_ROUTE,
    handler: async (input) => {
      const session = requireRunningSession(runtime);
      const mintUrl =
        input.mintUrl === undefined
          ? session.mintUrl
          : parseMintUrl(input.mintUrl, 'The Mint URL is invalid');
      try {
        const operation =
          input.source !== undefined
            ? await preparePaymentRequestSend(session, input, mintUrl)
            : await session.manager.ops.send.prepare({
                mintUrl,
                amount: input.amount,
                unit: input.unit,
                ...(input.forceSwap !== undefined ? { forceSwap: input.forceSwap } : {}),
              });
        return new V1HttpResponse(toSendOperationDocument(operation), 201);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        if (input.source !== undefined) {
          throw paymentRequestCocoError('prepare the Payment Request', error);
        }
        throw sendOperationCocoError('prepare the Send Operation', error);
      }
    },
  });
  const getSendOperation = defineV1Route({
    ...GET_SEND_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const session = requireRunningSession(runtime);
      const operationId = parseSendOperationId(request);
      try {
        const operation = await session.manager.ops.send.get(operationId);
        if (!operation) throw sendOperationNotFound();
        return toSendOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw sendOperationCocoError('return the Send Operation', error);
      }
    },
  });
  const listSendOperations = (
    route: typeof LIST_PREPARED_SEND_OPERATIONS_ROUTE | typeof LIST_IN_FLIGHT_SEND_OPERATIONS_ROUTE,
    kind: 'prepared' | 'in-flight',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const send = requireRunningSession(runtime).manager.ops.send;
        const { offset, limit } = parseSendOperationPageQuery(request, kind);
        try {
          const operations =
            kind === 'prepared' ? await send.listPrepared() : await send.listInFlight();
          return {
            items: operations
              .toSorted(compareOperationsForPagination)
              .slice(offset, offset + limit)
              .map(toSendOperationDocument),
            offset,
            limit,
          };
        } catch (error) {
          throw sendOperationCocoError(`list ${kind} Send Operations`, error);
        }
      },
    });
  const listPreparedSendOperations = listSendOperations(
    LIST_PREPARED_SEND_OPERATIONS_ROUTE,
    'prepared',
  );
  const listInFlightSendOperations = listSendOperations(
    LIST_IN_FLIGHT_SEND_OPERATIONS_ROUTE,
    'in-flight',
  );
  const executeSendOperation = defineV1Route({
    ...EXECUTE_SEND_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const session = requireRunningSession(runtime);
      const operationId = parseSendOperationId(request, 'execute');
      try {
        const { operation, token } = await session.manager.ops.send.execute(operationId);
        return {
          operation: toSendOperationDocument(operation),
          result: { token: session.manager.wallet.encodeToken(token) },
        };
      } catch (error) {
        throw sendOperationCocoError('execute the Send Operation', error);
      }
    },
  });
  const getSendOperationResult = defineV1Route({
    ...GET_SEND_OPERATION_RESULT_ROUTE,
    handler: async (_input, request) => {
      const session = requireRunningSession(runtime);
      const operationId = parseSendOperationId(request, 'result');
      try {
        const operation = await session.manager.ops.send.get(operationId);
        if (!operation) throw sendOperationNotFound();
        if (
          (operation.state !== 'pending' && operation.state !== 'finalized') ||
          !operation.token
        ) {
          throw new V1HttpError({
            status: 409,
            code: 'operation_result_not_available',
            message: 'The Send Operation result is not available',
            retryable: operation.state === 'executing',
            details: { state: operation.state },
          });
        }
        return { token: session.manager.wallet.encodeToken(operation.token) };
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw sendOperationCocoError('return the Send Operation result', error);
      }
    },
  });
  const sendOperationCommand = (
    route:
      | typeof CANCEL_SEND_OPERATION_ROUTE
      | typeof REFRESH_SEND_OPERATION_ROUTE
      | typeof RECLAIM_SEND_OPERATION_ROUTE,
    command: 'cancel' | 'refresh' | 'reclaim',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const send = requireRunningSession(runtime).manager.ops.send;
        const operationId = parseSendOperationId(request, command);
        try {
          await send[command](operationId);
          const operation = await send.get(operationId);
          if (!operation) throw sendOperationNotFound();
          return toSendOperationDocument(operation);
        } catch (error) {
          if (error instanceof V1HttpError) throw error;
          throw sendOperationCocoError(`${command} the Send Operation`, error);
        }
      },
    });
  const cancelSendOperation = sendOperationCommand(CANCEL_SEND_OPERATION_ROUTE, 'cancel');
  const refreshSendOperation = sendOperationCommand(REFRESH_SEND_OPERATION_ROUTE, 'refresh');
  const reclaimSendOperation = sendOperationCommand(RECLAIM_SEND_OPERATION_ROUTE, 'reclaim');
  return [
    createSendOperation,
    listPreparedSendOperations,
    listInFlightSendOperations,
    getSendOperation,
    executeSendOperation,
    getSendOperationResult,
    cancelSendOperation,
    refreshSendOperation,
    reclaimSendOperation,
  ];
}
