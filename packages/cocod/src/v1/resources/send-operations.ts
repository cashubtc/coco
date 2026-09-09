import { normalizeMintUrl, type SendOperation } from '@cashu/coco-core';
import { V1HttpError, V1HttpResponse } from '../contract.js';
import { defineResourceRoute } from '../resource.js';
import {
  createSendOperationRequestSchema,
  executeSendOperationResponseSchema,
  noBodySchema,
  sendOperationSchema,
  sendOperationsSchema,
  sendResultSchema,
  type CreateSendOperationRequest,
  type SendOperationDocument,
} from '../schema.js';
import {
  createOperationCocoErrorMapper,
  operationNotFound,
  paymentRequestCocoError,
} from './errors.js';
import {
  compareOperationsForPagination,
  PAGE_PARAMETERS,
  parseMintUrl,
  parseOperationId,
  parsePageQuery,
  pathParameter,
} from './parameters.js';
import { requireRunningSession, type RunningSession } from './session.js';

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

const sendOperationCocoError = createOperationCocoErrorMapper('send');

const listSendOperations = (kind: 'prepared' | 'in-flight') =>
  defineResourceRoute({
    method: 'GET',
    path: `/v1/operations/send/${kind}`,
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: sendOperationsSchema,
    parameters: PAGE_PARAMETERS,
    handler: async (_input, request, { runtime }) => {
      const send = requireRunningSession(runtime).manager.ops.send;
      const { offset, limit } = parsePageQuery(
        request,
        `The ${kind} Send Operation filters are invalid`,
      );
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

const sendOperationCommand = (command: 'cancel' | 'refresh' | 'reclaim') =>
  defineResourceRoute({
    method: 'POST',
    path: `/v1/operations/send/{operationId}/${command}`,
    capability: 'wallet:admin',
    requestSchema: noBodySchema,
    responseSchema: sendOperationSchema,
    idempotencyKey: 'optional',
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const send = requireRunningSession(runtime).manager.ops.send;
      const operationId = parseOperationId(request, 'send', command);
      try {
        await send[command](operationId);
        const operation = await send.get(operationId);
        if (!operation) throw operationNotFound('send');
        return toSendOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw sendOperationCocoError(`${command} the Send Operation`, error);
      }
    },
  });

export const sendOperationsRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/send',
    capability: 'wallet:admin',
    requestSchema: createSendOperationRequestSchema,
    responseSchema: sendOperationSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _request, { runtime }) => {
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
  }),
  listSendOperations('prepared'),
  listSendOperations('in-flight'),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/send/{operationId}',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: sendOperationSchema,
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const session = requireRunningSession(runtime);
      const operationId = parseOperationId(request, 'send');
      try {
        const operation = await session.manager.ops.send.get(operationId);
        if (!operation) throw operationNotFound('send');
        return toSendOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw sendOperationCocoError('return the Send Operation', error);
      }
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/send/{operationId}/execute',
    capability: 'wallet:admin',
    requestSchema: noBodySchema,
    responseSchema: executeSendOperationResponseSchema,
    idempotencyKey: 'optional',
    responseCacheControl: 'no-store',
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const session = requireRunningSession(runtime);
      const operationId = parseOperationId(request, 'send', 'execute');
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
  }),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/send/{operationId}/result',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: sendResultSchema,
    responseCacheControl: 'no-store',
    parameters: [pathParameter('operationId')],
    handler: async (_input, request, { runtime }) => {
      const session = requireRunningSession(runtime);
      const operationId = parseOperationId(request, 'send', 'result');
      try {
        const operation = await session.manager.ops.send.get(operationId);
        if (!operation) throw operationNotFound('send');
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
  }),
  sendOperationCommand('cancel'),
  sendOperationCommand('refresh'),
  sendOperationCommand('reclaim'),
];
