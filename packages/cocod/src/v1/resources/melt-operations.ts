import { normalizeMintUrl, type MeltOperation } from '@cashu/coco-core';
import { V1HttpError, V1HttpResponse } from '../contract.js';
import { defineResourceRoute } from '../resource.js';
import {
  createMeltOperationRequestSchema,
  executeMeltOperationResponseSchema,
  meltOperationSchema,
  meltOperationsSchema,
  meltResultSchema,
  noBodySchema,
  type MeltOperationDocument,
  type MeltResultDocument,
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

const meltOperationCocoError = createOperationCocoErrorMapper('melt');

function toMeltResultDocument(operation: MeltOperation): MeltResultDocument | null {
  if (operation.state !== 'finalized' || !operation.finalizedData) return null;
  if (operation.method === 'onchain') {
    return operation.finalizedData.outpoint ? { outpoint: operation.finalizedData.outpoint } : null;
  }
  return operation.finalizedData.preimage ? { preimage: operation.finalizedData.preimage } : null;
}

const listMeltOperations = (kind: 'prepared' | 'in-flight') =>
  defineResourceRoute({
    method: 'GET',
    path: `/v1/operations/melt/${kind}`,
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: meltOperationsSchema,
    parameters: PAGE_PARAMETERS,
    handler: async (_input, request, { runtime }) => {
      const melt = requireRunningSession(runtime).manager.ops.melt;
      const { offset, limit } = parsePageQuery(
        request,
        `The ${kind} Melt Operation filters are invalid`,
      );
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

const meltOperationCommand = (command: 'cancel' | 'refresh' | 'reclaim') =>
  defineResourceRoute({
    method: 'POST',
    path: `/v1/operations/melt/{operationId}/${command}`,
    capability: 'wallet:admin',
    requestSchema: noBodySchema,
    responseSchema: meltOperationSchema,
    idempotencyKey: 'optional',
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const melt = requireRunningSession(runtime).manager.ops.melt;
      const operationId = parseOperationId(request, 'melt', command);
      try {
        await melt[command](operationId);
        const operation = await melt.get(operationId);
        if (!operation) throw operationNotFound('melt');
        return toMeltOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw meltOperationCocoError(`${command} the Melt Operation`, error);
      }
    },
  });

export const meltOperationsRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/melt',
    capability: 'wallet:admin',
    requestSchema: createMeltOperationRequestSchema,
    responseSchema: meltOperationSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _request, { runtime }) => {
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
  }),
  listMeltOperations('prepared'),
  listMeltOperations('in-flight'),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/melt/{operationId}',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: meltOperationSchema,
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const melt = requireRunningSession(runtime).manager.ops.melt;
      const operationId = parseOperationId(request, 'melt');
      try {
        const operation = await melt.get(operationId);
        if (!operation) throw operationNotFound('melt');
        return toMeltOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw meltOperationCocoError('return the Melt Operation', error);
      }
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/melt/{operationId}/execute',
    capability: 'wallet:admin',
    requestSchema: noBodySchema,
    responseSchema: executeMeltOperationResponseSchema,
    idempotencyKey: 'optional',
    responseCacheControl: 'no-store',
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const melt = requireRunningSession(runtime).manager.ops.melt;
      const operationId = parseOperationId(request, 'melt', 'execute');
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
  }),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/melt/{operationId}/result',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: meltResultSchema,
    responseCacheControl: 'no-store',
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const melt = requireRunningSession(runtime).manager.ops.melt;
      const operationId = parseOperationId(request, 'melt', 'result');
      try {
        const operation = await melt.get(operationId);
        if (!operation) throw operationNotFound('melt');
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
  }),
  meltOperationCommand('cancel'),
  meltOperationCommand('refresh'),
  meltOperationCommand('reclaim'),
];
