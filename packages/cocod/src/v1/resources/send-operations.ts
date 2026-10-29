import type { Manager, SendOperation } from '@cashu/coco-core';

import type { RunningCocoSession } from '../../runtime.js';
import { V1HttpError, V1HttpResponse } from '../contract.js';
import { noBodySchema } from '../schema.js';
import {
  emptyCommandRequestSchema,
  executeSendOperationResponseSchema,
  prepareSendOperationRequestSchema,
  sendOperationSchema,
  sendOperationsSchema,
  sendResultSchema,
  type PrepareSendOperationRequest,
  type SendOperationDocument,
} from '../resource-schemas.js';
import { operationNotFound, withCocoErrors } from './errors.js';
import {
  defineResourceRoute,
  fromMillis,
  normalizeRequestMintUrl,
  pageParameters,
  paginate,
  pathIdentifier,
  requireRunningSession,
} from './shared.js';

const operationId = { operationId: pathIdentifier('Send Operation ID.') };

function toSendOperationDocument(operation: SendOperation): SendOperationDocument {
  return {
    id: operation.id,
    type: 'send',
    state: operation.state,
    mintUrl: operation.mintUrl,
    method: operation.method,
    unit: operation.unit,
    amount: operation.amount.toString(),
    ...(operation.state !== 'init'
      ? {
          inputAmount: operation.inputAmount.toString(),
          fee: operation.fee.toString(),
          needsSwap: operation.needsSwap,
        }
      : {}),
    createdAt: fromMillis(operation.createdAt),
    updatedAt: fromMillis(operation.updatedAt),
  };
}

async function readSendOperation(manager: Manager, id: string): Promise<SendOperation> {
  const operation = await withCocoErrors({ action: 'read the Send Operation' }, () =>
    manager.ops.send.get(id),
  );
  if (!operation) throw operationNotFound('send', id);
  return operation;
}

/**
 * Prepares the in-band Send that pays an outgoing Payment Request. Without an explicit Mint, the
 * configured Mint is used when it can pay, otherwise the first Mint Coco reports as payable.
 */
async function preparePaymentRequestSend(
  session: RunningCocoSession,
  input: Extract<PrepareSendOperationRequest, { source: unknown }>,
): Promise<SendOperation> {
  const { manager } = session;
  const action = { action: 'prepare the Payment Request' };
  const resolved = await withCocoErrors(action, () =>
    manager.paymentRequests.parse(input.source.request),
  );
  if (resolved.transport.type !== 'inband') {
    throw new V1HttpError({
      status: 409,
      code: 'unsupported_behavior',
      message: 'Cocod pays only in-band Payment Requests',
      retryable: false,
      details: { transport: resolved.transport.type },
    });
  }
  let mintUrl: string;
  if (input.mintUrl !== undefined) {
    mintUrl = normalizeRequestMintUrl(input.mintUrl);
  } else if (resolved.payableMints.includes(session.mintUrl)) {
    mintUrl = session.mintUrl;
  } else if (resolved.payableMints[0] !== undefined) {
    mintUrl = resolved.payableMints[0];
  } else {
    throw new V1HttpError({
      status: 409,
      code: 'payment_request_unpayable',
      message: 'No Known Mint can pay the Payment Request',
      retryable: false,
    });
  }
  const amount =
    input.amount === undefined
      ? undefined
      : input.unit === undefined
        ? input.amount
        : { amount: input.amount, unit: input.unit };
  const prepared = await withCocoErrors(action, () =>
    manager.paymentRequests.prepare(resolved, {
      mintUrl,
      ...(amount !== undefined ? { amount } : {}),
    }),
  );
  return prepared.sendOperation;
}

function listRoute(collection: 'prepared' | 'in-flight') {
  return defineResourceRoute({
    method: 'GET',
    path: `/v1/operations/send/${collection}`,
    capability: 'wallet:read',
    summary:
      collection === 'prepared'
        ? 'List prepared Send Operations'
        : 'List in-flight Send Operations',
    requestSchema: noBodySchema,
    responseSchema: sendOperationsSchema,
    parameters: pageParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const operations = await withCocoErrors({ action: 'list Send Operations' }, () =>
        collection === 'prepared'
          ? manager.ops.send.listPrepared()
          : manager.ops.send.listInFlight(),
      );
      return paginate(operations, (operation) => operation, toSendOperationDocument, params);
    },
  });
}

function commandRoute(command: 'cancel' | 'refresh' | 'reclaim') {
  return defineResourceRoute({
    method: 'POST',
    path: `/v1/operations/send/{operationId}/${command}`,
    capability: 'wallet:admin',
    summary: {
      cancel: 'Cancel a prepared Send Operation and release its reservations',
      refresh: 'Reconcile a Send Operation with the Mint',
      reclaim: 'Reclaim the proofs of a pending Send Operation',
    }[command],
    requestSchema: emptyCommandRequestSchema,
    responseSchema: sendOperationSchema,
    idempotencyKey: 'optional',
    parameters: operationId,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      await withCocoErrors(
        { action: `${command} the Send Operation`, remoteEffect: command === 'reclaim' },
        async () => {
          await manager.ops.send[command](params.operationId);
        },
      );
      return toSendOperationDocument(await readSendOperation(manager, params.operationId));
    },
  });
}

export const sendOperationRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/send',
    capability: 'wallet:admin',
    summary: 'Prepare a Send Operation without executing it',
    requestSchema: prepareSendOperationRequestSchema,
    responseSchema: sendOperationSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _context, { runtime }) => {
      const session = requireRunningSession(runtime);
      const operation =
        'source' in input
          ? await preparePaymentRequestSend(session, input)
          : await withCocoErrors({ action: 'prepare the Send Operation' }, () =>
              session.manager.ops.send.prepare({
                mintUrl:
                  input.mintUrl === undefined
                    ? session.mintUrl
                    : normalizeRequestMintUrl(input.mintUrl),
                amount: input.amount,
                ...(input.unit !== undefined ? { unit: input.unit } : {}),
                ...(input.forceSwap !== undefined ? { forceSwap: input.forceSwap } : {}),
              }),
            );
      return new V1HttpResponse(toSendOperationDocument(operation), 201);
    },
  }),
  listRoute('prepared'),
  listRoute('in-flight'),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/send/{operationId}',
    capability: 'wallet:read',
    summary: 'Read a Send Operation',
    requestSchema: noBodySchema,
    responseSchema: sendOperationSchema,
    parameters: operationId,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      return toSendOperationDocument(await readSendOperation(manager, params.operationId));
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/send/{operationId}/execute',
    capability: 'wallet:admin',
    summary: 'Execute a prepared Send Operation and return its token',
    requestSchema: emptyCommandRequestSchema,
    responseSchema: executeSendOperationResponseSchema,
    idempotencyKey: 'optional',
    responseCacheControl: 'no-store',
    parameters: operationId,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const { operation, token } = await withCocoErrors(
        { action: 'execute the Send Operation', remoteEffect: true },
        () => manager.ops.send.execute(params.operationId),
      );
      return {
        operation: toSendOperationDocument(operation),
        result: { token: manager.wallet.encodeToken(token) },
      };
    },
  }),
  defineResourceRoute({
    method: 'GET',
    // The token is bearer value, so retrieving it requires the same capability as creating it.
    path: '/v1/operations/send/{operationId}/result',
    capability: 'wallet:admin',
    summary: 'Read the token of an executed Send Operation',
    requestSchema: noBodySchema,
    responseSchema: sendResultSchema,
    responseCacheControl: 'no-store',
    parameters: operationId,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const operation = await readSendOperation(manager, params.operationId);
      if ((operation.state !== 'pending' && operation.state !== 'finalized') || !operation.token) {
        throw new V1HttpError({
          status: 409,
          code: 'operation_result_not_available',
          message: 'The Send Operation has no token to return in its current state',
          retryable: operation.state === 'executing',
          details: { operationType: 'send', operationId: operation.id, state: operation.state },
        });
      }
      return { token: manager.wallet.encodeToken(operation.token) };
    },
  }),
  commandRoute('cancel'),
  commandRoute('refresh'),
  commandRoute('reclaim'),
];
