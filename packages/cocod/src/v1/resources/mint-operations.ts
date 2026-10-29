import type { Manager, MintOperation } from '@cashu/coco-core';

import { V1HttpResponse } from '../contract.js';
import { noBodySchema } from '../schema.js';
import {
  emptyCommandRequestSchema,
  mintOperationSchema,
  mintOperationsSchema,
  prepareMintOperationRequestSchema,
  type MintOperationDocument,
} from '../resource-schemas.js';
import { operationNotFound, withCocoErrors } from './errors.js';
import {
  defineResourceRoute,
  fromMillis,
  fromSeconds,
  normalizeRequestMintUrl,
  notFound,
  pageParameters,
  paginate,
  pathIdentifier,
  requireRunningSession,
} from './shared.js';

const operationId = { operationId: pathIdentifier('Mint Operation ID.') };

function toMintOperationDocument(operation: MintOperation): MintOperationDocument {
  const failure = operation.terminalFailure;
  return {
    id: operation.id,
    type: 'mint',
    state: operation.state,
    mintUrl: operation.mintUrl,
    method: operation.method,
    unit: operation.unit,
    amount: operation.amount.toString(),
    quote: { mintUrl: operation.mintUrl, quoteId: operation.quoteId },
    ...(operation.state !== 'init'
      ? { expiry: operation.expiry === null ? null : fromSeconds(operation.expiry) }
      : {}),
    // The failure reason is Mint-supplied text, so only its structured fields are exposed.
    ...(failure
      ? {
          failure: {
            ...(failure.code !== undefined ? { code: failure.code } : {}),
            ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
            observedAt: fromMillis(failure.observedAt),
          },
        }
      : {}),
    createdAt: fromMillis(operation.createdAt),
    updatedAt: fromMillis(operation.updatedAt),
  };
}

async function readMintOperation(manager: Manager, id: string): Promise<MintOperation> {
  const operation = await withCocoErrors({ action: 'read the Mint Operation' }, () =>
    manager.ops.mint.get(id),
  );
  if (!operation) throw operationNotFound('mint', id);
  return operation;
}

function listRoute(collection: 'pending' | 'in-flight') {
  return defineResourceRoute({
    method: 'GET',
    path: `/v1/operations/mint/${collection}`,
    capability: 'wallet:read',
    summary:
      collection === 'pending'
        ? 'List pending Mint Operations'
        : 'List pending and executing Mint Operations',
    requestSchema: noBodySchema,
    responseSchema: mintOperationsSchema,
    parameters: pageParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const operations = await withCocoErrors({ action: 'list Mint Operations' }, () =>
        collection === 'pending' ? manager.ops.mint.listPending() : manager.ops.mint.listInFlight(),
      );
      return paginate(operations, (operation) => operation, toMintOperationDocument, params);
    },
  });
}

export const mintOperationRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/mint',
    capability: 'wallet:admin',
    summary: 'Prepare a pending Mint Operation for a Mint Quote without executing it',
    requestSchema: prepareMintOperationRequestSchema,
    responseSchema: mintOperationSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _context, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const identity = { mintUrl: normalizeRequestMintUrl(input.mintUrl), quoteId: input.quoteId };
      const action = { action: 'prepare the Mint Operation' };
      const quote = await withCocoErrors(action, () => manager.quotes.mint.get(identity));
      if (!quote) throw notFound('The Mint Quote does not exist', { ...identity });
      const operation = await withCocoErrors(action, () =>
        manager.ops.mint.prepare({ quote, amount: input.amount }),
      );
      return new V1HttpResponse(toMintOperationDocument(operation), 201);
    },
  }),
  listRoute('pending'),
  listRoute('in-flight'),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/mint/{operationId}',
    capability: 'wallet:read',
    summary: 'Read a Mint Operation',
    requestSchema: noBodySchema,
    responseSchema: mintOperationSchema,
    parameters: operationId,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      return toMintOperationDocument(await readMintOperation(manager, params.operationId));
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/mint/{operationId}/execute',
    capability: 'wallet:admin',
    summary: 'Redeem a paid Mint Operation, or resume one that is executing',
    requestSchema: emptyCommandRequestSchema,
    responseSchema: mintOperationSchema,
    idempotencyKey: 'optional',
    parameters: operationId,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const operation = await withCocoErrors(
        { action: 'execute the Mint Operation', remoteEffect: true },
        () => manager.ops.mint.execute(params.operationId),
      );
      return toMintOperationDocument(operation);
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/mint/{operationId}/refresh',
    capability: 'wallet:admin',
    summary: 'Reconcile a Mint Operation with its Mint Quote',
    requestSchema: emptyCommandRequestSchema,
    responseSchema: mintOperationSchema,
    idempotencyKey: 'optional',
    parameters: operationId,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const operation = await withCocoErrors({ action: 'refresh the Mint Operation' }, () =>
        manager.ops.mint.refresh(params.operationId),
      );
      return toMintOperationDocument(operation);
    },
  }),
];
