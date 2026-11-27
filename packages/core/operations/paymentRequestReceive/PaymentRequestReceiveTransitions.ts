import type {
  ReceiveOperation,
  FinalizedReceiveOperation,
  RolledBackReceiveOperation,
} from '../receive/ReceiveOperation.ts';
import type { Amount } from '@cashu/cashu-ts';
import {
  applyReceiveResult,
  prepareReceive,
  cancelReceive,
  failReceiveExecution,
} from '../receive/ReceiveTransitions.ts';
import type {
  ApplyReceiveResultInput,
  FailReceiveInput,
  ReceiveOperationInput,
  PrepareReceiveInput,
  PrepareReceiveResult,
} from '../receive/ReceiveTransitionTypes.ts';
import { OperationInProgressError, PaymentRequestError } from '@core/models/Error.ts';
import type { CoreTransaction } from '@core/transactions/CoreTransaction.ts';
import { defineTransition } from '@core/transactions/Transition.ts';
import {
  amountsFromReceive,
  assertPaymentRequestNetAmount,
  singleUseClaimConflict,
} from './PaymentRequestReceiveOperation.ts';
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

type AttemptLookup = { attemptId: string; findLegacyChild: boolean };

export const loadPaymentRequestAttempt = defineTransition(async (tx, input: AttemptLookup) => {
  const attempt = await tx.paymentRequestReceiveAttempts.getById(input.attemptId);
  if (!attempt) return null;
  const operation = await tx.paymentRequestReceiveOperations.getById(attempt.requestOperationId);
  const linked = attempt.receiveOperationId
    ? await tx.receiveOperations.getById(attempt.receiveOperationId)
    : null;
  // A freshly accepted delivery can only acquire a child together with its link.
  // Recovery also recognizes older wallets that committed the child first.
  const child =
    !linked && input.findLegacyChild
      ? await tx.receiveOperations.getByPaymentRequestAttemptId(attempt.id)
      : linked;
  return { attempt, operation, child };
});

export const beginPaymentRequestAttempt = defineTransition(
  async (tx, input: AttemptLookup & { updatedAt: number }) => {
    const stored = await tx.perform(loadPaymentRequestAttempt, input);
    if (stored?.attempt.state !== 'received') return stored;
    const attempt = { ...stored.attempt, state: 'validating' as const, updatedAt: input.updatedAt };
    await tx.paymentRequestReceiveAttempts.update(attempt);
    return { ...stored, attempt };
  },
);

type LinkInput = AttemptLookup & { updatedAt: number; preparation?: PrepareReceiveInput };

export const prepareAndLinkPaymentRequestChild = defineTransition(async (tx, input: LinkInput) => {
  const stored = await tx.perform(loadPaymentRequestAttempt, input);
  if (!stored || stored.attempt.state === 'rejected' || stored.attempt.state === 'finalized')
    return null;
  const { attempt, operation } = stored;
  if (!operation) throw new PaymentRequestError('Payment request receive operation was not found');
  let child = stored.child;
  let prepared: PrepareReceiveResult | undefined;
  if (!child || child.state === 'init') {
    if (!input.preparation || (child && child.id !== input.preparation.operation.id))
      throw new OperationInProgressError(attempt.id);
    if (operation.state !== 'active')
      throw new PaymentRequestError(
        `Cannot prepare payment for request in state '${operation.state}'`,
      );
    if (operation.singleUse) {
      const conflict = singleUseClaimConflict(
        await tx.paymentRequestReceiveAttempts.getByRequestOperationId(operation.id),
        attempt.id,
      );
      if (conflict) throw new PaymentRequestError(conflict);
    }
    prepared = await tx.perform(prepareReceive, input.preparation);
    child = prepared.operation;
  }
  const { fee, netAmount } = amountsFromReceive(child);
  if (child.state === 'prepared') assertPaymentRequestNetAmount(operation.amount, netAmount);
  if (
    attempt.state === 'receiving' &&
    attempt.receiveOperationId === child.id &&
    attempt.fee?.equals(fee) &&
    attempt.netAmount?.equals(netAmount)
  )
    return { attempt, child, prepared };
  const linked: PaymentRequestReceiveAttempt = {
    ...attempt,
    state: 'receiving',
    receiveOperationId: child.id,
    fee,
    netAmount,
    updatedAt: input.updatedAt,
  };
  await tx.paymentRequestReceiveAttempts.update(linked);
  return { attempt: linked, child, prepared };
});

/** A competing session may have linked or submitted the child while preflight was running. */
export const resolvePreSubmissionFailure = defineTransition(
  async (tx, input: AttemptLookup & { childId?: string; error?: string; updatedAt: number }) => {
    const stored = await tx.perform(loadPaymentRequestAttempt, input);
    if (!stored || stored.attempt.state === 'finalized' || stored.attempt.state === 'rejected')
      return;
    const { attempt, child } = stored;
    if (input.error === undefined) {
      if (!child) await tx.paymentRequestReceiveAttempts.delete(attempt.id);
      return;
    }
    if (
      child &&
      (child.id !== input.childId || (child.state !== 'init' && child.state !== 'prepared'))
    )
      return;
    if (child) {
      if (child.state === 'init') await assertLinked(tx, attempt, child);
      return cancelChild(
        tx,
        { operationId: child.id, updatedAt: input.updatedAt, reason: input.error },
        attempt,
      );
    }
    await tx.paymentRequestReceiveAttempts.update({
      ...attempt,
      state: 'rejected',
      payload: undefined,
      error: input.error,
      updatedAt: input.updatedAt,
    });
  },
);

type TerminalChild = FinalizedReceiveOperation | RolledBackReceiveOperation;

async function attemptForChild(tx: CoreTransaction, child: ReceiveOperation) {
  return child.source?.type === 'payment-request'
    ? tx.paymentRequestReceiveAttempts.getById(child.source.attemptId)
    : tx.paymentRequestReceiveAttempts.getByReceiveOperationId(child.id);
}

async function assertLinked(
  tx: CoreTransaction,
  attempt: PaymentRequestReceiveAttempt,
  child: ReceiveOperation,
) {
  const source = child.source;
  if (
    source?.type === 'payment-request' &&
    (source.attemptId !== attempt.id || source.requestOperationId !== attempt.requestOperationId)
  ) {
    throw new PaymentRequestError('Receive child belongs to a different payment request attempt');
  }
  // Older wallets can retain a link to a missing row. A surviving child with the
  // matching source can repair it, but cannot replace another live child.
  if (
    attempt.receiveOperationId &&
    attempt.receiveOperationId !== child.id &&
    (await tx.receiveOperations.getById(attempt.receiveOperationId))
  ) {
    throw new PaymentRequestError('Payment request attempt is linked to another Receive child');
  }
}

async function completeSingleUse(
  tx: CoreTransaction,
  attempt: PaymentRequestReceiveAttempt,
  updatedAt: number,
) {
  const parent = await tx.paymentRequestReceiveOperations.getById(attempt.requestOperationId);
  if (!parent?.singleUse || parent.state === 'completed') return;
  const completed = { ...parent, state: 'completed' as const, updatedAt, completedAt: updatedAt };
  await tx.paymentRequestReceiveOperations.update(completed);
  return completed;
}

/** The child is the durable result read or written in this same transaction. */
async function recordOutcome(
  tx: CoreTransaction,
  attempt: PaymentRequestReceiveAttempt,
  child: TerminalChild,
  updatedAt: number,
) {
  await assertLinked(tx, attempt, child);
  const state = child.state === 'finalized' ? 'finalized' : 'rejected';
  if ((attempt.state === 'finalized' || attempt.state === 'rejected') && attempt.state !== state)
    throw new PaymentRequestError(
      'Receive child conflicts with the recorded payment request outcome',
    );
  const { fee, netAmount } = amountsFromReceive(child);
  const error =
    child.state === 'rolled_back'
      ? (child.error ?? 'Child receive operation rolled back')
      : undefined;
  if (
    attempt.state !== state ||
    attempt.error !== error ||
    attempt.receiveOperationId !== child.id ||
    attempt.payload ||
    !attempt.fee?.equals(fee) ||
    !attempt.netAmount?.equals(netAmount)
  ) {
    attempt = {
      ...attempt,
      state,
      receiveOperationId: child.id,
      fee,
      netAmount,
      payload: undefined,
      error,
      updatedAt,
    };
    await tx.paymentRequestReceiveAttempts.update(attempt);
  }
  const completed =
    state === 'finalized' ? await completeSingleUse(tx, attempt, updatedAt) : undefined;
  return { attempt, completed };
}

/** Commit the proofs and every record describing their receipt before publishing the result. */
export const settleReceiveResult = defineTransition(async (tx, input: ApplyReceiveResultInput) => {
  const result = await tx.perform(applyReceiveResult, input);
  if (!result) return null;
  const attempt = await attemptForChild(tx, result.operation);
  const settlement =
    attempt && (await recordOutcome(tx, attempt, result.operation, input.updatedAt));
  return { ...result, completedRequest: settlement?.completed };
});

export const failReceiveDelivery = defineTransition(async (tx, input: FailReceiveInput) => {
  const child = await tx.perform(failReceiveExecution, input);
  const attempt = await attemptForChild(tx, child);
  if (attempt) await recordOutcome(tx, attempt, child, input.updatedAt);
  return child;
});

type CancelChildInput = ReceiveOperationInput & { reason: string };

async function cancelChild(
  tx: CoreTransaction,
  input: CancelChildInput,
  attempt?: PaymentRequestReceiveAttempt | null,
) {
  const cancelled = await tx.perform(cancelReceive, input);
  if (!attempt) return cancelled;
  if (cancelled) {
    await recordOutcome(tx, attempt, cancelled, input.updatedAt);
  } else if (attempt.state !== 'finalized' && attempt.state !== 'rejected') {
    // Cancelling a legacy init child deletes its row. Retire its payload in the same commit.
    await tx.paymentRequestReceiveAttempts.update({
      ...attempt,
      state: 'rejected',
      receiveOperationId: undefined,
      payload: undefined,
      error: input.reason,
      updatedAt: input.updatedAt,
    });
  }
  return cancelled;
}

export const cancelReceiveDelivery = defineTransition(async (tx, input: CancelChildInput) => {
  const child = await tx.receiveOperations.getById(input.operationId);
  const attempt = child && (await attemptForChild(tx, child));
  if (child?.state === 'init' && attempt) await assertLinked(tx, attempt, child);
  return cancelChild(tx, input, attempt);
});

/** Repair a historical split commit using only durable evidence, including a finalized attempt whose child is gone. */
export const repairPaymentRequestSettlement = defineTransition(
  async (tx, input: AttemptLookup & { updatedAt: number }) => {
    const stored = await tx.perform(loadPaymentRequestAttempt, input);
    if (!stored) return;
    const { attempt, child, operation } = stored;
    // Another session may have cancelled the parent after recovery selected this finalized attempt.
    if (attempt.state === 'finalized' && operation?.state !== 'active')
      return { attempt, completed: undefined };
    if (child?.state === 'finalized' || child?.state === 'rolled_back')
      return recordOutcome(tx, attempt, child, input.updatedAt);
    const completed =
      attempt.state === 'finalized'
        ? await completeSingleUse(tx, attempt, input.updatedAt)
        : undefined;
    return { attempt, completed };
  },
);
