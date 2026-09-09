import { normalizeMintUrl, type MintOperation } from '@cashu/coco-core';
import { V1HttpError, V1HttpResponse } from '../contract.js';
import { defineResourceRoute } from '../resource.js';
import {
  createMintOperationRequestSchema,
  mintOperationSchema,
  mintOperationsSchema,
  noBodySchema,
  noSuccessResponseSchema,
  type MintOperationDocument,
} from '../schema.js';
import { createOperationCocoErrorMapper, operationNotFound, quoteNotFound } from './errors.js';
import {
  compareOperationsForPagination,
  PAGE_PARAMETERS,
  parseMintUrl,
  parseOperationId,
  parsePageQuery,
  pathParameter,
} from './parameters.js';
import { requireRunningSession } from './session.js';

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

const mintOperationCocoError = createOperationCocoErrorMapper('mint');

const listMintOperations = (kind: 'pending' | 'in-flight') =>
  defineResourceRoute({
    method: 'GET',
    path: `/v1/operations/mint/${kind}`,
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: mintOperationsSchema,
    parameters: PAGE_PARAMETERS,
    handler: async (_input, request, { runtime }) => {
      const mint = requireRunningSession(runtime).manager.ops.mint;
      const { offset, limit } = parsePageQuery(
        request,
        `The ${kind} Mint Operation filters are invalid`,
      );
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

const mintOperationCommand = (command: 'execute' | 'refresh') =>
  defineResourceRoute({
    method: 'POST',
    path: `/v1/operations/mint/{operationId}/${command}`,
    capability: 'wallet:admin',
    requestSchema: noBodySchema,
    responseSchema: mintOperationSchema,
    idempotencyKey: 'optional',
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const mint = requireRunningSession(runtime).manager.ops.mint;
      const operationId = parseOperationId(request, 'mint', command);
      try {
        return toMintOperationDocument(await mint[command](operationId));
      } catch (error) {
        throw mintOperationCocoError(`${command} the Mint Operation`, error);
      }
    },
  });

export const mintOperationsRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/mint',
    capability: 'wallet:admin',
    requestSchema: createMintOperationRequestSchema,
    responseSchema: mintOperationSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _request, { runtime }) => {
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
  }),
  listMintOperations('pending'),
  listMintOperations('in-flight'),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/mint/{operationId}',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: mintOperationSchema,
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const mint = requireRunningSession(runtime).manager.ops.mint;
      const operationId = parseOperationId(request, 'mint');
      try {
        const operation = await mint.get(operationId);
        if (!operation) throw operationNotFound('mint');
        return toMintOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw mintOperationCocoError('return the Mint Operation', error);
      }
    },
  }),
  mintOperationCommand('execute'),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/mint/{operationId}/result',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: noSuccessResponseSchema,
    successStatuses: [],
    responseCacheControl: 'no-store',
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      requireRunningSession(runtime);
      parseOperationId(request, 'mint', 'result');
      throw new V1HttpError({
        status: 404,
        code: 'not_found',
        message: 'Mint Operations do not expose a distinct result',
        retryable: false,
      });
    },
  }),
  mintOperationCommand('refresh'),
];
