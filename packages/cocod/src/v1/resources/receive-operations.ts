import { normalizeMintUrl, type ReceiveOperation } from '@cashu/coco-core';
import { V1HttpError, V1HttpResponse } from '../contract.js';
import { defineResourceRoute } from '../resource.js';
import {
  createReceiveOperationRequestSchema,
  noBodySchema,
  noSuccessResponseSchema,
  receiveOperationSchema,
  receiveOperationsSchema,
  type ReceiveOperationDocument,
} from '../schema.js';
import { createOperationCocoErrorMapper, operationNotFound } from './errors.js';
import {
  compareOperationsForPagination,
  PAGE_PARAMETERS,
  parseOperationId,
  parsePageQuery,
  pathParameter,
} from './parameters.js';
import { requireRunningSession } from './session.js';

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

const receiveOperationCocoError = createOperationCocoErrorMapper('receive');

const listReceiveOperations = (kind: 'prepared' | 'in-flight') =>
  defineResourceRoute({
    method: 'GET',
    path: `/v1/operations/receive/${kind}`,
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: receiveOperationsSchema,
    parameters: PAGE_PARAMETERS,
    handler: async (_input, request, { runtime }) => {
      const receive = requireRunningSession(runtime).manager.ops.receive;
      const { offset, limit } = parsePageQuery(
        request,
        `The ${kind} Receive Operation filters are invalid`,
      );
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

const receiveOperationCommand = (command: 'cancel' | 'refresh') =>
  defineResourceRoute({
    method: 'POST',
    path: `/v1/operations/receive/{operationId}/${command}`,
    capability: 'wallet:admin',
    requestSchema: noBodySchema,
    responseSchema: receiveOperationSchema,
    idempotencyKey: 'optional',
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const receive = requireRunningSession(runtime).manager.ops.receive;
      const operationId = parseOperationId(request, 'receive', command);
      try {
        await receive[command](operationId);
        const operation = await receive.get(operationId);
        if (!operation) throw operationNotFound('receive');
        return toReceiveOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw receiveOperationCocoError(`${command} the Receive Operation`, error);
      }
    },
  });

export const receiveOperationsRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/receive',
    capability: 'wallet:admin',
    requestSchema: createReceiveOperationRequestSchema,
    responseSchema: receiveOperationSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _request, { runtime }) => {
      const receive = requireRunningSession(runtime).manager.ops.receive;
      try {
        const operation = await receive.prepare({ token: input.token });
        return new V1HttpResponse(toReceiveOperationDocument(operation), 201);
      } catch (error) {
        throw receiveOperationCocoError('prepare the Receive Operation', error);
      }
    },
  }),
  listReceiveOperations('prepared'),
  listReceiveOperations('in-flight'),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/receive/{operationId}',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: receiveOperationSchema,
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const receive = requireRunningSession(runtime).manager.ops.receive;
      const operationId = parseOperationId(request, 'receive');
      try {
        const operation = await receive.get(operationId);
        if (!operation) throw operationNotFound('receive');
        return toReceiveOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw receiveOperationCocoError('return the Receive Operation', error);
      }
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/receive/{operationId}/execute',
    capability: 'wallet:admin',
    requestSchema: noBodySchema,
    responseSchema: receiveOperationSchema,
    idempotencyKey: 'optional',
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const receive = requireRunningSession(runtime).manager.ops.receive;
      const operationId = parseOperationId(request, 'receive', 'execute');
      try {
        return toReceiveOperationDocument(await receive.execute(operationId));
      } catch (error) {
        throw receiveOperationCocoError('execute the Receive Operation', error);
      }
    },
  }),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/receive/{operationId}/result',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: noSuccessResponseSchema,
    successStatuses: [],
    responseCacheControl: 'no-store',
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      requireRunningSession(runtime);
      parseOperationId(request, 'receive', 'result');
      throw new V1HttpError({
        status: 404,
        code: 'not_found',
        message: 'Receive Operations do not expose a distinct result',
        retryable: false,
      });
    },
  }),
  receiveOperationCommand('cancel'),
  receiveOperationCommand('refresh'),
];
