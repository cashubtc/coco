import type { Manager, ReceiveOperation } from '@cashu/coco-core';

import { V1HttpResponse } from '../contract.js';
import { noBodySchema } from '../schema.js';
import {
  emptyCommandRequestSchema,
  prepareReceiveOperationRequestSchema,
  receiveOperationSchema,
  receiveOperationsSchema,
  type ReceiveOperationDocument,
} from '../resource-schemas.js';
import { operationNotFound, withCocoErrors } from './errors.js';
import {
  defineResourceRoute,
  fromMillis,
  pageParameters,
  paginate,
  pathIdentifier,
  requireRunningSession,
} from './shared.js';

const operationIdParameters = { operationId: pathIdentifier('Receive Operation ID.') };

function toReceiveOperationDocument(operation: ReceiveOperation): ReceiveOperationDocument {
  return {
    id: operation.id,
    type: 'receive',
    state: operation.state,
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    amount: operation.amount.toString(),
    ...(operation.state !== 'init' ? { fee: operation.fee.toString() } : {}),
    createdAt: fromMillis(operation.createdAt),
    updatedAt: fromMillis(operation.updatedAt),
  };
}

async function readReceiveOperation(manager: Manager, id: string): Promise<ReceiveOperation> {
  const operation = await withCocoErrors({ action: 'read the Receive Operation' }, () =>
    manager.ops.receive.get(id),
  );
  if (!operation) throw operationNotFound('receive', id);
  return operation;
}

function listRoute(collection: 'prepared' | 'in-flight') {
  return defineResourceRoute({
    method: 'GET',
    path: `/v1/operations/receive/${collection}`,
    capability: 'wallet:read',
    summary:
      collection === 'prepared'
        ? 'List prepared Receive Operations'
        : 'List in-flight Receive Operations',
    requestSchema: noBodySchema,
    responseSchema: receiveOperationsSchema,
    parameters: pageParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const operations = await withCocoErrors({ action: 'list Receive Operations' }, () =>
        collection === 'prepared'
          ? manager.ops.receive.listPrepared()
          : manager.ops.receive.listInFlight(),
      );
      return paginate(operations, (operation) => operation, toReceiveOperationDocument, params);
    },
  });
}

function commandRoute(command: 'cancel' | 'refresh') {
  return defineResourceRoute({
    method: 'POST',
    path: `/v1/operations/receive/{operationId}/${command}`,
    capability: 'wallet:admin',
    summary:
      command === 'cancel'
        ? 'Cancel a Receive Operation that has not executed'
        : 'Reconcile a Receive Operation with the Mint',
    requestSchema: emptyCommandRequestSchema,
    responseSchema: receiveOperationSchema,
    idempotencyKey: 'optional',
    parameters: operationIdParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      await withCocoErrors({ action: `${command} the Receive Operation` }, async () => {
        await manager.ops.receive[command](params.operationId);
      });
      return toReceiveOperationDocument(await readReceiveOperation(manager, params.operationId));
    },
  });
}

export const receiveOperationRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/receive',
    capability: 'wallet:admin',
    summary: 'Prepare a Receive Operation for a Cashu token without executing it',
    requestSchema: prepareReceiveOperationRequestSchema,
    responseSchema: receiveOperationSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _context, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const operation = await withCocoErrors({ action: 'prepare the Receive Operation' }, () =>
        manager.ops.receive.prepare({ token: input.token }),
      );
      return new V1HttpResponse(toReceiveOperationDocument(operation), 201);
    },
  }),
  listRoute('prepared'),
  listRoute('in-flight'),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/receive/{operationId}',
    capability: 'wallet:read',
    summary: 'Read a Receive Operation',
    requestSchema: noBodySchema,
    responseSchema: receiveOperationSchema,
    parameters: operationIdParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      return toReceiveOperationDocument(await readReceiveOperation(manager, params.operationId));
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/receive/{operationId}/execute',
    capability: 'wallet:admin',
    summary: 'Execute a prepared Receive Operation',
    requestSchema: emptyCommandRequestSchema,
    responseSchema: receiveOperationSchema,
    idempotencyKey: 'optional',
    parameters: operationIdParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const operation = await withCocoErrors(
        { action: 'execute the Receive Operation', remoteEffect: true },
        () => manager.ops.receive.execute(params.operationId),
      );
      return toReceiveOperationDocument(operation);
    },
  }),
  commandRoute('cancel'),
  commandRoute('refresh'),
];
