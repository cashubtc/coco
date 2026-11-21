import { PaymentRequestError } from '@core/models/Error.ts';
import type { CoreTransaction } from '@core/transactions/CoreTransaction.ts';
import { defineTransition } from '@core/transactions/Transition.ts';
import type { PaymentRequestReceiveOperation } from './PaymentRequestReceiveOperation.ts';

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
