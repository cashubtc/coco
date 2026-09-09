import {
  normalizeMintUrl,
  MeltOperationNotFoundError,
  MeltOperationStateError,
  type MeltOperation,
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
  createMeltOperationRequestSchema,
  executeMeltOperationResponseSchema,
  meltOperationSchema,
  meltOperationsSchema,
  meltResultSchema,
  noBodySchema,
  type CreateMeltOperationRequest,
  type ExecuteMeltOperationResponseDocument,
  type MeltOperationDocument,
  type MeltOperationsDocument,
  type MeltResultDocument,
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
  parseMintUrl,
  compareOperationsForPagination,
} from './parameters.js';
import { quoteNotFound, createOperationCocoErrorMapper } from './errors.js';

const CREATE_MELT_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/melt',
  capability: 'wallet:admin',
  requestSchema: createMeltOperationRequestSchema,
  responseSchema: meltOperationSchema,
  successStatuses: [201],
  idempotencyKey: 'optional',
} as const satisfies V1RouteMetadata<CreateMeltOperationRequest, MeltOperationDocument>;

const GET_MELT_OPERATION_ROUTE = {
  method: 'GET',
  path: '/v1/operations/melt/{operationId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: meltOperationSchema,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, MeltOperationDocument>;

const LIST_PREPARED_MELT_OPERATIONS_ROUTE = {
  method: 'GET',
  path: '/v1/operations/melt/prepared',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: meltOperationsSchema,
  parameters: PAGE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, MeltOperationsDocument>;

const LIST_IN_FLIGHT_MELT_OPERATIONS_ROUTE = {
  ...LIST_PREPARED_MELT_OPERATIONS_ROUTE,
  path: '/v1/operations/melt/in-flight',
} as const satisfies V1RouteMetadata<null, MeltOperationsDocument>;

const EXECUTE_MELT_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/melt/{operationId}/execute',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: executeMeltOperationResponseSchema,
  idempotencyKey: 'optional',
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, ExecuteMeltOperationResponseDocument>;

const GET_MELT_OPERATION_RESULT_ROUTE = {
  method: 'GET',
  path: '/v1/operations/melt/{operationId}/result',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: meltResultSchema,
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, MeltResultDocument>;

const CANCEL_MELT_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/melt/{operationId}/cancel',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: meltOperationSchema,
  idempotencyKey: 'optional',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, MeltOperationDocument>;

const REFRESH_MELT_OPERATION_ROUTE = {
  ...CANCEL_MELT_OPERATION_ROUTE,
  path: '/v1/operations/melt/{operationId}/refresh',
} as const satisfies V1RouteMetadata<null, MeltOperationDocument>;

const RECLAIM_MELT_OPERATION_ROUTE = {
  ...CANCEL_MELT_OPERATION_ROUTE,
  path: '/v1/operations/melt/{operationId}/reclaim',
} as const satisfies V1RouteMetadata<null, MeltOperationDocument>;

function toMeltOperationDocument(operation: MeltOperation): MeltOperationDocument {
  const mintUrl = normalizeMintUrl(operation.mintUrl);
  const base = {
    id: operation.id,
    type: 'melt' as const,
    mintUrl,
    unit: operation.unit,
    method: operation.method,
    createdAt: new Date(operation.createdAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
  };
  if (operation.state === 'init') {
    return {
      ...base,
      state: operation.state,
      ...(operation.quoteId ? { quote: { mintUrl, quoteId: operation.quoteId } } : {}),
    };
  }
  const methodData = operation.methodData as { feeIndex?: number };
  return {
    ...base,
    state: operation.state,
    amount: operation.amount.toString(),
    quote: { mintUrl, quoteId: operation.quoteId },
    feeReserve: operation.fee_reserve.toString(),
    swapFee: operation.swap_fee.toString(),
    inputAmount: operation.inputAmount.toString(),
    needsSwap: operation.needsSwap,
    ...(operation.method === 'onchain' && methodData.feeIndex !== undefined
      ? { feeIndex: methodData.feeIndex }
      : {}),
    ...(operation.state === 'finalized' && operation.changeAmount !== undefined
      ? { changeAmount: operation.changeAmount.toString() }
      : {}),
    ...(operation.state === 'finalized' && operation.effectiveFee !== undefined
      ? { effectiveFee: operation.effectiveFee.toString() }
      : {}),
  };
}

const meltOperationCocoError = createOperationCocoErrorMapper({
  type: 'melt',
  label: 'Melt',
  notFoundError: MeltOperationNotFoundError,
  stateError: MeltOperationStateError,
  notFound: meltOperationNotFound,
});

function toMeltResultDocument(operation: MeltOperation): MeltResultDocument | null {
  if (operation.state !== 'finalized' || !operation.finalizedData) return null;
  if (operation.method === 'onchain') {
    return operation.finalizedData.outpoint ? { outpoint: operation.finalizedData.outpoint } : null;
  }
  return operation.finalizedData.preimage ? { preimage: operation.finalizedData.preimage } : null;
}

function meltOperationNotFound(cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Melt Operation does not exist',
    retryable: false,
    cause,
  });
}

function parseMeltOperationPageQuery(
  request: Request,
  kind: 'prepared' | 'in-flight',
): { offset: number; limit: number } {
  const message = `The ${kind} Melt Operation filters are invalid`;
  const route =
    kind === 'prepared'
      ? LIST_PREPARED_MELT_OPERATIONS_ROUTE
      : LIST_IN_FLIGHT_MELT_OPERATIONS_ROUTE;
  const query = parseQuery(request, queryParameterNames(route.parameters), message);
  return {
    offset: parsePageInteger(query.getAll('offset'), 0, Number.MAX_SAFE_INTEGER, 0, message),
    limit: parsePageInteger(query.getAll('limit'), 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, message),
  };
}

function parseMeltOperationId(request: Request, command?: string): string {
  const message = 'The Melt Operation identity is invalid';
  parseQuery(request, [], message);
  return parsePathIdentity(request, '/v1/operations/melt/', command ? `/${command}` : '', message);
}

export const meltOperationsMetadata = [
  CREATE_MELT_OPERATION_ROUTE,
  LIST_PREPARED_MELT_OPERATIONS_ROUTE,
  LIST_IN_FLIGHT_MELT_OPERATIONS_ROUTE,
  GET_MELT_OPERATION_ROUTE,
  EXECUTE_MELT_OPERATION_ROUTE,
  GET_MELT_OPERATION_RESULT_ROUTE,
  CANCEL_MELT_OPERATION_ROUTE,
  REFRESH_MELT_OPERATION_ROUTE,
  RECLAIM_MELT_OPERATION_ROUTE,
];

export function createMeltOperationsRoutes(runtime: V1Runtime): V1RouteDefinition[] {
  const createMeltOperation = defineV1Route({
    ...CREATE_MELT_OPERATION_ROUTE,
    handler: async (input) => {
      const session = requireRunningSession(runtime);
      const mintUrl = parseMintUrl(input.mintUrl, 'The Mint URL is invalid');
      try {
        const quote = await session.manager.quotes.melt.get({
          mintUrl,
          quoteId: input.quoteId,
        });
        if (!quote) throw quoteNotFound('Melt');
        if (quote.method === 'onchain' && input.feeIndex === undefined) {
          throw new V1HttpError({
            status: 400,
            code: 'invalid_request',
            message: 'feeIndex is required for an on-chain Melt Quote',
            retryable: false,
          });
        }
        const operation = await session.manager.ops.melt.prepare({
          quote,
          ...(input.feeIndex !== undefined ? { feeIndex: input.feeIndex } : {}),
        } as Parameters<typeof session.manager.ops.melt.prepare>[0]);
        return new V1HttpResponse(toMeltOperationDocument(operation), 201);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw meltOperationCocoError('prepare the Melt Operation', error);
      }
    },
  });
  const getMeltOperation = defineV1Route({
    ...GET_MELT_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const melt = requireRunningSession(runtime).manager.ops.melt;
      const operationId = parseMeltOperationId(request);
      try {
        const operation = await melt.get(operationId);
        if (!operation) throw meltOperationNotFound();
        return toMeltOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw meltOperationCocoError('return the Melt Operation', error);
      }
    },
  });
  const listMeltOperations = (
    route: typeof LIST_PREPARED_MELT_OPERATIONS_ROUTE | typeof LIST_IN_FLIGHT_MELT_OPERATIONS_ROUTE,
    kind: 'prepared' | 'in-flight',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const melt = requireRunningSession(runtime).manager.ops.melt;
        const { offset, limit } = parseMeltOperationPageQuery(request, kind);
        try {
          const operations =
            kind === 'prepared' ? await melt.listPrepared() : await melt.listInFlight();
          return {
            items: operations
              .toSorted(compareOperationsForPagination)
              .slice(offset, offset + limit)
              .map(toMeltOperationDocument),
            offset,
            limit,
          };
        } catch (error) {
          throw meltOperationCocoError(`list ${kind} Melt Operations`, error);
        }
      },
    });
  const listPreparedMeltOperations = listMeltOperations(
    LIST_PREPARED_MELT_OPERATIONS_ROUTE,
    'prepared',
  );
  const listInFlightMeltOperations = listMeltOperations(
    LIST_IN_FLIGHT_MELT_OPERATIONS_ROUTE,
    'in-flight',
  );
  const executeMeltOperation = defineV1Route({
    ...EXECUTE_MELT_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const melt = requireRunningSession(runtime).manager.ops.melt;
      const operationId = parseMeltOperationId(request, 'execute');
      try {
        const operation = await melt.execute(operationId);
        const result = toMeltResultDocument(operation);
        return {
          operation: toMeltOperationDocument(operation),
          ...(result ? { result } : {}),
        };
      } catch (error) {
        throw meltOperationCocoError('execute the Melt Operation', error);
      }
    },
  });
  const getMeltOperationResult = defineV1Route({
    ...GET_MELT_OPERATION_RESULT_ROUTE,
    handler: async (_input, request) => {
      const melt = requireRunningSession(runtime).manager.ops.melt;
      const operationId = parseMeltOperationId(request, 'result');
      try {
        const operation = await melt.get(operationId);
        if (!operation) throw meltOperationNotFound();
        const result = toMeltResultDocument(operation);
        if (!result) {
          throw new V1HttpError({
            status: 409,
            code: 'operation_result_not_available',
            message: 'The Melt Operation result is not available',
            retryable: operation.state === 'executing' || operation.state === 'pending',
            details: { state: operation.state },
          });
        }
        return result;
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw meltOperationCocoError('return the Melt Operation result', error);
      }
    },
  });
  const meltOperationCommand = (
    route:
      | typeof CANCEL_MELT_OPERATION_ROUTE
      | typeof REFRESH_MELT_OPERATION_ROUTE
      | typeof RECLAIM_MELT_OPERATION_ROUTE,
    command: 'cancel' | 'refresh' | 'reclaim',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const melt = requireRunningSession(runtime).manager.ops.melt;
        const operationId = parseMeltOperationId(request, command);
        try {
          await melt[command](operationId);
          const operation = await melt.get(operationId);
          if (!operation) throw meltOperationNotFound();
          return toMeltOperationDocument(operation);
        } catch (error) {
          if (error instanceof V1HttpError) throw error;
          throw meltOperationCocoError(`${command} the Melt Operation`, error);
        }
      },
    });
  const cancelMeltOperation = meltOperationCommand(CANCEL_MELT_OPERATION_ROUTE, 'cancel');
  const refreshMeltOperation = meltOperationCommand(REFRESH_MELT_OPERATION_ROUTE, 'refresh');
  const reclaimMeltOperation = meltOperationCommand(RECLAIM_MELT_OPERATION_ROUTE, 'reclaim');
  return [
    createMeltOperation,
    listPreparedMeltOperations,
    listInFlightMeltOperations,
    getMeltOperation,
    executeMeltOperation,
    getMeltOperationResult,
    cancelMeltOperation,
    refreshMeltOperation,
    reclaimMeltOperation,
  ];
}
