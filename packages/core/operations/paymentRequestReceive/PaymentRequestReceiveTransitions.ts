import type { Amount } from '@cashu/cashu-ts';
import { PaymentRequestError } from '@core/models/Error.ts';
import type { CoreTransaction } from '@core/transactions/CoreTransaction.ts';
import { defineTransition } from '@core/transactions/Transition.ts';
import { singleUseClaimConflict } from './PaymentRequestReceiveOperation.ts';
import type {
  ParsedPaymentRequestPayload,
  PaymentRequestReceiveAttempt,
  PaymentRequestReceiveSource,
  PaymentRequestReceiveOperation,
} from './PaymentRequestReceiveOperation.ts';

export const createPaymentRequestReceive = defineTransition(
  async (tx, operation: PaymentRequestReceiveOperation & { requestId: string }) => {
    const active = await tx.paymentRequestReceiveOperations.getActiveByRequestId(
      operation.requestId,
    );
    if (active.length) return false;
    for (const mintUrl of operation.mints) await tx.mintMetadata.assertTrusted(mintUrl);
    await tx.paymentRequestReceiveOperations.create(operation);
    return true;
  },
);

type CancelInput = { operationId: string; reason?: string; updatedAt: number };

async function saveCancellation(
  tx: CoreTransaction,
  operation: PaymentRequestReceiveOperation,
  { reason, updatedAt }: CancelInput,
): Promise<PaymentRequestReceiveOperation> {
  const cancelled = { ...operation, state: 'cancelled' as const, error: reason, updatedAt };
  await tx.paymentRequestReceiveOperations.update(cancelled);
  return cancelled;
}

export const cancelPaymentRequestReceive = defineTransition(async (tx, input: CancelInput) => {
  const operation = await tx.paymentRequestReceiveOperations.getById(input.operationId);
  if (!operation) {
    throw new PaymentRequestError(
      `Payment request receive operation ${input.operationId} not found`,
    );
  }
  if (operation.state !== 'active') {
    throw new PaymentRequestError(
      `Cannot cancel payment request receive operation in state '${operation.state}'`,
    );
  }
  return saveCancellation(tx, operation, input);
});

export const cancelAfterActivationFailure = defineTransition(async (tx, input: CancelInput) => {
  const operation = await tx.paymentRequestReceiveOperations.getById(input.operationId);
  if (operation?.state !== 'active') return null;
  const attempts = await tx.paymentRequestReceiveAttempts.getByRequestOperationId(operation.id);
  if (attempts.some((attempt) => attempt.state !== 'rejected')) return null;
  return saveCancellation(tx, operation, input);
});

export type AcceptDeliveryInput = {
  operationId?: string;
  payload: ParsedPaymentRequestPayload;
  source?: PaymentRequestReceiveSource;
  payloadHash: string;
  grossAmount: Amount;
  attemptId: string;
  now: number;
};

type Delivery = {
  operation: PaymentRequestReceiveOperation;
  attempt: PaymentRequestReceiveAttempt;
};

async function loadOperation(tx: CoreTransaction, id: string) {
  const operation = await tx.paymentRequestReceiveOperations.getById(id);
  if (!operation)
    throw new PaymentRequestError(`Payment request receive operation ${id} not found`);
  return operation;
}

async function locateDelivery(tx: CoreTransaction, input: AcceptDeliveryInput) {
  const { operationId, payloadHash, payload, source } = input;
  const attempts = tx.paymentRequestReceiveAttempts;
  const messageId = source?.transportMessageId;
  const byMessage = messageId ? await attempts.getByTransportMessageId(messageId) : null;
  if (byMessage) {
    if (operationId !== undefined && byMessage.requestOperationId !== operationId) {
      throw new PaymentRequestError(
        `Transport message ${messageId} belongs to another payment request receive operation`,
      );
    }
    if (byMessage.payloadHash !== payloadHash) {
      throw new PaymentRequestError(
        `Transport message ${messageId} belongs to a different payload`,
      );
    }
    return {
      operation: await loadOperation(tx, byMessage.requestOperationId),
      existing: byMessage,
    };
  }

  let operation: PaymentRequestReceiveOperation;
  if (operationId !== undefined) {
    operation = await loadOperation(tx, operationId);
  } else {
    if (!payload.id)
      throw new PaymentRequestError('Payment request payload id is required for ingestion');
    // A settled replay belongs to the original request, even after its public ID was reused.
    const existing = await attempts.getByRequestIdAndPayloadHash(payload.id, payloadHash);
    if (existing?.state === 'finalized') {
      return { operation: await loadOperation(tx, existing.requestOperationId), existing };
    }
    const active = await tx.paymentRequestReceiveOperations.getActiveByRequestId(payload.id);
    if (!active.length) {
      if (existing)
        return { operation: await loadOperation(tx, existing.requestOperationId), existing };
      throw new PaymentRequestError(`No active payment request found for id ${payload.id}`);
    }
    if (active.length > 1)
      throw new PaymentRequestError(`Multiple active payment requests found for id ${payload.id}`);
    operation = active[0]!;
  }
  return { operation, existing: await attempts.getByPayloadHash(operation.id, payloadHash) };
}

export const acceptPaymentRequestDelivery = defineTransition(
  async (
    tx,
    input: AcceptDeliveryInput & { lockedOperationId?: string },
  ): Promise<
    { kind: 'lock'; operationId: string } | ({ kind: 'stored' | 'accepted' } & Delivery)
  > => {
    const { operation, existing } = await locateDelivery(tx, input);
    if (existing) return { kind: 'stored', operation, attempt: existing };
    if (operation.state !== 'active') {
      throw new PaymentRequestError(
        `Cannot claim payload for payment request receive operation in state '${operation.state}'`,
      );
    }
    if (operation.id !== input.lockedOperationId)
      return { kind: 'lock', operationId: operation.id };

    const { source, payload, now } = input;
    const attempts = tx.paymentRequestReceiveAttempts;
    const prior = operation.singleUse ? await attempts.getByRequestOperationId(operation.id) : [];
    const conflict = singleUseClaimConflict(prior);
    const attempt: PaymentRequestReceiveAttempt = {
      id: input.attemptId,
      requestOperationId: operation.id,
      requestId: payload.id,
      transport: source?.transport ?? operation.transport,
      transportMessageId: source?.transportMessageId,
      senderPubkey: source?.senderPubkey,
      payloadHash: input.payloadHash,
      memo: payload.memo,
      mintUrl: payload.mint,
      unit: payload.unit,
      grossAmount: input.grossAmount,
      createdAt: now,
      updatedAt: now,
      ...(conflict ? { state: 'rejected', error: conflict } : { state: 'received', payload }),
    };
    await attempts.create(attempt);
    return { kind: conflict ? 'stored' : 'accepted', operation, attempt };
  },
);
