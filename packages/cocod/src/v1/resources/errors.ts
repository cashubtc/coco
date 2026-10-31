import {
  HttpResponseError,
  KeysetSyncError,
  MeltQuoteValidationError,
  MintFetchError,
  MintOperationError,
  MintQuoteValidationError,
  MintSwapChildOperationError,
  NetworkError,
  OperationInProgressError,
  OperationNotFoundError,
  OperationStateError,
  PaymentRequestError,
  ProofValidationError,
  ReceiveOperationConflictError,
  SendOperationConflictError,
  TokenValidationError,
  UnitValidationError,
  UnknownMintError,
  type LifecycleOperationType,
} from '@cashu/coco-core';

import { V1HttpError } from '../contract.js';

export interface CocoErrorContext {
  /** Diagnostic phrase completing "Coco could not …". */
  action: string;
  /**
   * Set for commands that may have reached the Mint before failing, such as execute. Their
   * remote failures are not retryable as-is: the Operation is authoritative and must be re-read.
   */
  remoteEffect?: boolean;
}

/**
 * Maps a failure from a public Coco interface to a stable v1 error.
 *
 * Only typed Coco errors receive Wallet-domain codes; cocod never infers a code from message
 * text. Messages are fixed diagnostic phrases so Mint responses and Wallet data never reach
 * clients or logs through error text.
 */
export function toV1Error(cause: unknown, context: CocoErrorContext): V1HttpError {
  if (cause instanceof V1HttpError) return cause;

  if (cause instanceof OperationNotFoundError) {
    return new V1HttpError({
      status: 404,
      code: 'not_found',
      message: 'The Operation does not exist',
      retryable: false,
      details: { operationType: cause.operationType, operationId: cause.operationId },
      cause,
    });
  }
  if (cause instanceof OperationStateError) {
    return new V1HttpError({
      status: 409,
      code: 'invalid_operation_state',
      message: 'The Operation command is unavailable in its current state',
      retryable: false,
      details: {
        operationType: cause.operationType,
        operationId: cause.operationId,
        state: cause.state,
        expectedStates: [...cause.expectedStates],
        ...(cause.quoteState !== undefined ? { quoteState: cause.quoteState } : {}),
      },
      cause,
    });
  }
  if (
    cause instanceof SendOperationConflictError ||
    cause instanceof ReceiveOperationConflictError
  ) {
    return new V1HttpError({
      status: 409,
      code: 'operation_conflict',
      message: 'The Operation changed concurrently; read it before retrying',
      retryable: false,
      details: {
        operationType: cause instanceof SendOperationConflictError ? 'send' : 'receive',
        operationId: cause.operationId,
      },
      cause,
    });
  }
  if (cause instanceof OperationInProgressError) {
    return new V1HttpError({
      status: 409,
      code: 'operation_in_progress',
      message: 'Another command for this Operation is in progress',
      retryable: true,
      details: { operationId: cause.operationId },
      headers: { 'Retry-After': '1' },
      cause,
    });
  }
  if (cause instanceof MintSwapChildOperationError) {
    return new V1HttpError({
      status: 409,
      code: 'operation_coordinated',
      message: 'The Operation or Quote is coordinated by a Mint Swap',
      retryable: false,
      details: { parentOperationId: cause.parentOperationId },
      cause,
    });
  }
  if (cause instanceof UnknownMintError) {
    return new V1HttpError({
      status: 409,
      code: 'mint_unavailable',
      message: 'The selected Mint is unknown or untrusted',
      retryable: false,
      cause,
    });
  }
  if (
    cause instanceof PaymentRequestError ||
    cause instanceof UnitValidationError ||
    cause instanceof ProofValidationError ||
    cause instanceof TokenValidationError ||
    cause instanceof MintQuoteValidationError ||
    cause instanceof MeltQuoteValidationError
  ) {
    return new V1HttpError({
      status: 400,
      code: 'invalid_request',
      message: 'Coco rejected the Wallet request',
      retryable: false,
      cause,
    });
  }
  // MintOperationError is the Mint's protocol-level rejection (a NUT error code); check it before
  // its HttpResponseError base so it is not reported as an unreachable Mint.
  if (cause instanceof MintOperationError) {
    return new V1HttpError({
      status: 409,
      code: 'mint_rejected',
      message: 'The Mint rejected the request',
      retryable: false,
      details: { mintErrorCode: cause.code },
      cause,
    });
  }
  if (
    cause instanceof NetworkError ||
    cause instanceof MintFetchError ||
    cause instanceof KeysetSyncError ||
    (cause instanceof HttpResponseError && cause.status >= 500)
  ) {
    return new V1HttpError({
      status: 502,
      code: 'mint_unreachable',
      message: 'Coco could not reach the Mint',
      retryable: !context.remoteEffect,
      ...(context.remoteEffect ? {} : { headers: { 'Retry-After': '1' } }),
      cause,
    });
  }
  if (cause instanceof HttpResponseError) {
    return new V1HttpError({
      status: 409,
      code: 'mint_rejected',
      message: 'The Mint rejected the request',
      retryable: false,
      details: { mintStatus: cause.status },
      cause,
    });
  }
  return new V1HttpError({
    status: 500,
    code: 'coco_error',
    message: `Coco could not ${context.action}`,
    retryable: false,
    cause,
  });
}

/** Runs one Coco call and maps its failure with the given context. */
export async function withCocoErrors<T>(
  context: CocoErrorContext,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw toV1Error(error, context);
  }
}

/** The 404 a lookup returns when Coco has no Operation with this ID. */
export function operationNotFound(
  operationType: LifecycleOperationType,
  operationId: string,
): V1HttpError {
  return toV1Error(new OperationNotFoundError(operationType, operationId), {
    action: 'read the Operation',
  });
}
