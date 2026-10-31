import type { Manager, MeltOperation, MeltQuote, PrepareMeltInput } from '@cashu/coco-core';

import { V1HttpError, V1HttpResponse } from '../contract.js';
import { noBodySchema } from '../schema.js';
import {
  emptyCommandRequestSchema,
  executeMeltOperationResponseSchema,
  meltOperationSchema,
  meltOperationsSchema,
  meltResultSchema,
  prepareMeltOperationRequestSchema,
  type MeltOperationDocument,
  type MeltResultDocument,
} from '../resource-schemas.js';
import { operationNotFound, withCocoErrors } from './errors.js';
import {
  defineResourceRoute,
  fromMillis,
  normalizeRequestMintUrl,
  notFound,
  pageParameters,
  paginate,
  pathIdentifier,
  requireRunningSession,
} from './shared.js';

const operationIdParameters = { operationId: pathIdentifier('Melt Operation ID.') };

function toMeltOperationDocument(operation: MeltOperation): MeltOperationDocument {
  const base = {
    id: operation.id,
    type: 'melt' as const,
    mintUrl: operation.mintUrl,
    method: operation.method,
    unit: operation.unit,
    createdAt: fromMillis(operation.createdAt),
    updatedAt: fromMillis(operation.updatedAt),
  };
  if (operation.state === 'init') {
    return {
      ...base,
      state: operation.state,
      ...(operation.quoteId
        ? { quote: { mintUrl: operation.mintUrl, quoteId: operation.quoteId } }
        : {}),
    };
  }
  return {
    ...base,
    state: operation.state,
    quote: { mintUrl: operation.mintUrl, quoteId: operation.quoteId },
    amount: operation.amount.toString(),
    feeReserve: operation.fee_reserve.toString(),
    swapFee: operation.swap_fee.toString(),
    inputAmount: operation.inputAmount.toString(),
    needsSwap: operation.needsSwap,
    ...('feeIndex' in operation.methodData && typeof operation.methodData.feeIndex === 'number'
      ? { feeIndex: operation.methodData.feeIndex }
      : {}),
    ...(operation.state === 'finalized' && operation.changeAmount !== undefined
      ? { changeAmount: operation.changeAmount.toString() }
      : {}),
    ...(operation.state === 'finalized' && operation.effectiveFee !== undefined
      ? { effectiveFee: operation.effectiveFee.toString() }
      : {}),
  };
}

/** Proof of payment of a finalized Melt Operation, when the Mint supplied one. */
function toMeltResultDocument(operation: MeltOperation): MeltResultDocument | undefined {
  if (operation.state !== 'finalized' || !operation.finalizedData) return undefined;
  const { preimage, outpoint } = operation.finalizedData;
  if (preimage) return { preimage };
  if (outpoint) return { outpoint };
  return undefined;
}

async function readMeltOperation(manager: Manager, id: string): Promise<MeltOperation> {
  const operation = await withCocoErrors({ action: 'read the Melt Operation' }, () =>
    manager.ops.melt.get(id),
  );
  if (!operation) throw operationNotFound('melt', id);
  return operation;
}

function invalidFeeIndex(message: string): V1HttpError {
  return new V1HttpError({
    status: 400,
    code: 'invalid_request',
    message,
    retryable: false,
    details: { field: 'feeIndex' },
  });
}

/**
 * BOLT quotes have a single fee reserve, so v1 rejects the `feeIndex` Coco would ignore. Coco owns
 * the on-chain fee option rules and rejects a missing or unknown one with a typed error.
 */
function prepareMelt(manager: Manager, quote: MeltQuote, feeIndex: number | undefined) {
  if (quote.method !== 'onchain' && feeIndex !== undefined) {
    throw invalidFeeIndex('Only on-chain Melt Quotes accept feeIndex');
  }
  // The request schema cannot correlate `feeIndex` with the method of a stored quote.
  return manager.ops.melt.prepare({ quote, feeIndex } as PrepareMeltInput);
}

function listRoute(collection: 'prepared' | 'in-flight') {
  return defineResourceRoute({
    method: 'GET',
    path: `/v1/operations/melt/${collection}`,
    capability: 'wallet:read',
    summary:
      collection === 'prepared'
        ? 'List prepared Melt Operations'
        : 'List in-flight Melt Operations',
    requestSchema: noBodySchema,
    responseSchema: meltOperationsSchema,
    parameters: pageParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const operations = await withCocoErrors({ action: 'list Melt Operations' }, () =>
        collection === 'prepared'
          ? manager.ops.melt.listPrepared()
          : manager.ops.melt.listInFlight(),
      );
      return paginate(operations, (operation) => operation, toMeltOperationDocument, params);
    },
  });
}

function commandRoute(command: 'cancel' | 'refresh' | 'reclaim') {
  return defineResourceRoute({
    method: 'POST',
    path: `/v1/operations/melt/{operationId}/${command}`,
    capability: 'wallet:admin',
    summary: {
      cancel: 'Cancel a prepared Melt Operation and release its reservations',
      refresh: 'Reconcile a Melt Operation with its Melt Quote',
      reclaim: 'Reclaim the proofs of a pending Melt Operation whose payment failed',
    }[command],
    requestSchema: emptyCommandRequestSchema,
    responseSchema: meltOperationSchema,
    idempotencyKey: 'optional',
    parameters: operationIdParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      await withCocoErrors({ action: `${command} the Melt Operation` }, async () => {
        await manager.ops.melt[command](params.operationId);
      });
      return toMeltOperationDocument(await readMeltOperation(manager, params.operationId));
    },
  });
}

export const meltOperationRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/melt',
    capability: 'wallet:admin',
    summary: 'Prepare a Melt Operation for a Melt Quote without paying it',
    requestSchema: prepareMeltOperationRequestSchema,
    responseSchema: meltOperationSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _context, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const identity = { mintUrl: normalizeRequestMintUrl(input.mintUrl), quoteId: input.quoteId };
      const action = { action: 'prepare the Melt Operation' };
      const quote = await withCocoErrors(action, () => manager.quotes.melt.get(identity));
      if (!quote) throw notFound('The Melt Quote does not exist', { ...identity });
      const operation = await withCocoErrors(action, () =>
        prepareMelt(manager, quote, input.feeIndex),
      );
      return new V1HttpResponse(toMeltOperationDocument(operation), 201);
    },
  }),
  listRoute('prepared'),
  listRoute('in-flight'),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/operations/melt/{operationId}',
    capability: 'wallet:read',
    summary: 'Read a Melt Operation',
    requestSchema: noBodySchema,
    responseSchema: meltOperationSchema,
    parameters: operationIdParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      return toMeltOperationDocument(await readMeltOperation(manager, params.operationId));
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/operations/melt/{operationId}/execute',
    capability: 'wallet:admin',
    summary: 'Pay a prepared Melt Operation',
    requestSchema: emptyCommandRequestSchema,
    responseSchema: executeMeltOperationResponseSchema,
    idempotencyKey: 'optional',
    responseCacheControl: 'no-store',
    parameters: operationIdParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const operation = await withCocoErrors(
        { action: 'execute the Melt Operation', remoteEffect: true },
        () => manager.ops.melt.execute(params.operationId),
      );
      const result = toMeltResultDocument(operation);
      return { operation: toMeltOperationDocument(operation), ...(result ? { result } : {}) };
    },
  }),
  defineResourceRoute({
    method: 'GET',
    // A preimage can act as a bearer credential, so reading it requires the admin capability.
    path: '/v1/operations/melt/{operationId}/result',
    capability: 'wallet:admin',
    summary: 'Read the proof of payment of a finalized Melt Operation',
    requestSchema: noBodySchema,
    responseSchema: meltResultSchema,
    responseCacheControl: 'no-store',
    parameters: operationIdParameters,
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const operation = await readMeltOperation(manager, params.operationId);
      const result = toMeltResultDocument(operation);
      if (!result) {
        throw new V1HttpError({
          status: 409,
          code: 'operation_result_not_available',
          message: 'The Melt Operation has no proof of payment in its current state',
          retryable: operation.state === 'executing' || operation.state === 'pending',
          details: { operationType: 'melt', operationId: operation.id, state: operation.state },
        });
      }
      return result;
    },
  }),
  commandRoute('cancel'),
  commandRoute('refresh'),
  commandRoute('reclaim'),
];
