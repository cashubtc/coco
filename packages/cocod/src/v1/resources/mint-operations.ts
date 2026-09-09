import {
  normalizeMintUrl,
  MintOperationNotFoundError,
  MintOperationStateError,
  type MintOperation,
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
  createMintOperationRequestSchema,
  mintOperationSchema,
  mintOperationsSchema,
  noSuccessResponseSchema,
  noBodySchema,
  type CreateMintOperationRequest,
  type MintOperationDocument,
  type MintOperationsDocument,
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

const CREATE_MINT_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/mint',
  capability: 'wallet:admin',
  requestSchema: createMintOperationRequestSchema,
  responseSchema: mintOperationSchema,
  successStatuses: [201],
  idempotencyKey: 'optional',
} as const satisfies V1RouteMetadata<CreateMintOperationRequest, MintOperationDocument>;

const GET_MINT_OPERATION_ROUTE = {
  method: 'GET',
  path: '/v1/operations/mint/{operationId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: mintOperationSchema,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, MintOperationDocument>;

const LIST_PENDING_MINT_OPERATIONS_ROUTE = {
  method: 'GET',
  path: '/v1/operations/mint/pending',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: mintOperationsSchema,
  parameters: PAGE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, MintOperationsDocument>;

const LIST_IN_FLIGHT_MINT_OPERATIONS_ROUTE = {
  ...LIST_PENDING_MINT_OPERATIONS_ROUTE,
  path: '/v1/operations/mint/in-flight',
} as const satisfies V1RouteMetadata<null, MintOperationsDocument>;

const EXECUTE_MINT_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/mint/{operationId}/execute',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: mintOperationSchema,
  idempotencyKey: 'optional',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, MintOperationDocument>;

const REFRESH_MINT_OPERATION_ROUTE = {
  ...EXECUTE_MINT_OPERATION_ROUTE,
  path: '/v1/operations/mint/{operationId}/refresh',
} as const satisfies V1RouteMetadata<null, MintOperationDocument>;

const GET_MINT_OPERATION_RESULT_ROUTE = {
  method: 'GET',
  path: '/v1/operations/mint/{operationId}/result',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: noSuccessResponseSchema,
  successStatuses: [],
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, never>;

function toMintOperationDocument(operation: MintOperation): MintOperationDocument {
  const mintUrl = normalizeMintUrl(operation.mintUrl);
  return {
    id: operation.id,
    type: 'mint',
    state: operation.state,
    mintUrl,
    unit: operation.unit,
    method: operation.method,
    amount: operation.amount.toString(),
    quote: { mintUrl, quoteId: operation.quoteId },
    ...(operation.state !== 'init'
      ? {
          expiry:
            operation.expiry === null ? null : new Date(operation.expiry * 1_000).toISOString(),
        }
      : {}),
    ...(operation.terminalFailure
      ? {
          failure: {
            reason: 'The Mint Operation failed',
            ...(operation.terminalFailure.code !== undefined
              ? { code: operation.terminalFailure.code }
              : {}),
            ...(operation.terminalFailure.retryable !== undefined
              ? { retryable: operation.terminalFailure.retryable }
              : {}),
            observedAt: new Date(operation.terminalFailure.observedAt).toISOString(),
          },
        }
      : {}),
    createdAt: new Date(operation.createdAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
  };
}

function parseMintOperationPageQuery(
  request: Request,
  kind: 'pending' | 'in-flight',
): { offset: number; limit: number } {
  const message = `The ${kind} Mint Operation filters are invalid`;
  const route =
    kind === 'pending' ? LIST_PENDING_MINT_OPERATIONS_ROUTE : LIST_IN_FLIGHT_MINT_OPERATIONS_ROUTE;
  const query = parseQuery(request, queryParameterNames(route.parameters), message);
  return {
    offset: parsePageInteger(query.getAll('offset'), 0, Number.MAX_SAFE_INTEGER, 0, message),
    limit: parsePageInteger(query.getAll('limit'), 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, message),
  };
}

const mintOperationCocoError = createOperationCocoErrorMapper({
  type: 'mint',
  label: 'Mint',
  notFoundError: MintOperationNotFoundError,
  stateError: MintOperationStateError,
  notFound: mintOperationNotFound,
});

function mintOperationNotFound(cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Mint Operation does not exist',
    retryable: false,
    cause,
  });
}

function parseMintOperationId(request: Request, command?: string): string {
  const message = 'The Mint Operation identity is invalid';
  parseQuery(request, [], message);
  return parsePathIdentity(request, '/v1/operations/mint/', command ? `/${command}` : '', message);
}

export const mintOperationsMetadata = [
  CREATE_MINT_OPERATION_ROUTE,
  LIST_PENDING_MINT_OPERATIONS_ROUTE,
  LIST_IN_FLIGHT_MINT_OPERATIONS_ROUTE,
  GET_MINT_OPERATION_ROUTE,
  EXECUTE_MINT_OPERATION_ROUTE,
  GET_MINT_OPERATION_RESULT_ROUTE,
  REFRESH_MINT_OPERATION_ROUTE,
];

export function createMintOperationsRoutes(runtime: V1Runtime): V1RouteDefinition[] {
  const createMintOperation = defineV1Route({
    ...CREATE_MINT_OPERATION_ROUTE,
    handler: async (input) => {
      const session = requireRunningSession(runtime);
      const mintUrl = parseMintUrl(input.mintUrl, 'The Mint URL is invalid');
      try {
        const quote = await session.manager.quotes.mint.get({
          mintUrl,
          quoteId: input.quoteId,
        });
        if (!quote) throw quoteNotFound('Mint');
        const operation = await session.manager.ops.mint.prepare({
          quote,
          amount: input.amount,
        });
        return new V1HttpResponse(toMintOperationDocument(operation), 201);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw mintOperationCocoError('prepare the Mint Operation', error);
      }
    },
  });
  const getMintOperation = defineV1Route({
    ...GET_MINT_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const mint = requireRunningSession(runtime).manager.ops.mint;
      const operationId = parseMintOperationId(request);
      try {
        const operation = await mint.get(operationId);
        if (!operation) throw mintOperationNotFound();
        return toMintOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw mintOperationCocoError('return the Mint Operation', error);
      }
    },
  });
  const listMintOperations = (
    route: typeof LIST_PENDING_MINT_OPERATIONS_ROUTE | typeof LIST_IN_FLIGHT_MINT_OPERATIONS_ROUTE,
    kind: 'pending' | 'in-flight',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const mint = requireRunningSession(runtime).manager.ops.mint;
        const { offset, limit } = parseMintOperationPageQuery(request, kind);
        try {
          const operations =
            kind === 'pending' ? await mint.listPending() : await mint.listInFlight();
          return {
            items: operations
              .toSorted(compareOperationsForPagination)
              .slice(offset, offset + limit)
              .map(toMintOperationDocument),
            offset,
            limit,
          };
        } catch (error) {
          throw mintOperationCocoError(`list ${kind} Mint Operations`, error);
        }
      },
    });
  const listPendingMintOperations = listMintOperations(
    LIST_PENDING_MINT_OPERATIONS_ROUTE,
    'pending',
  );
  const listInFlightMintOperations = listMintOperations(
    LIST_IN_FLIGHT_MINT_OPERATIONS_ROUTE,
    'in-flight',
  );
  const mintOperationCommand = (
    route: typeof EXECUTE_MINT_OPERATION_ROUTE | typeof REFRESH_MINT_OPERATION_ROUTE,
    command: 'execute' | 'refresh',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const mint = requireRunningSession(runtime).manager.ops.mint;
        const operationId = parseMintOperationId(request, command);
        try {
          return toMintOperationDocument(await mint[command](operationId));
        } catch (error) {
          throw mintOperationCocoError(`${command} the Mint Operation`, error);
        }
      },
    });
  const executeMintOperation = mintOperationCommand(EXECUTE_MINT_OPERATION_ROUTE, 'execute');
  const refreshMintOperation = mintOperationCommand(REFRESH_MINT_OPERATION_ROUTE, 'refresh');
  const getMintOperationResult = defineV1Route({
    ...GET_MINT_OPERATION_RESULT_ROUTE,
    handler: async (_input, request) => {
      requireRunningSession(runtime);
      parseMintOperationId(request, 'result');
      throw new V1HttpError({
        status: 404,
        code: 'not_found',
        message: 'Mint Operations do not expose a distinct result',
        retryable: false,
      });
    },
  });
  return [
    createMintOperation,
    listPendingMintOperations,
    listInFlightMintOperations,
    getMintOperation,
    executeMintOperation,
    getMintOperationResult,
    refreshMintOperation,
  ];
}
