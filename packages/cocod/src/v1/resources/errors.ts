import {
  MeltOperationNotFoundError,
  MeltOperationStateError,
  MintOperationNotFoundError,
  MintOperationStateError,
  MintQuoteValidationError,
  OperationInProgressError,
  PaymentRequestError,
  ProofValidationError,
  ReceiveOperationNotFoundError,
  ReceiveOperationStateError,
  SendOperationNotFoundError,
  SendOperationStateError,
  TokenValidationError,
  UnitValidationError,
  UnknownMintError,
} from '@cashu/coco-core';
import { V1HttpError } from '../contract.js';

export function paymentRequestCocoError(action: string, cause: unknown): V1HttpError {
  if (cause instanceof PaymentRequestError || cause instanceof UnitValidationError) {
    return new V1HttpError({
      status: 400,
      code: 'invalid_request',
      message: 'The Payment Request is invalid or cannot be paid',
      retryable: false,
      cause,
    });
  }
  return cocoError(action, cause);
}

const OPERATION_ERRORS = {
  mint: [MintOperationNotFoundError, MintOperationStateError],
  melt: [MeltOperationNotFoundError, MeltOperationStateError],
  send: [SendOperationNotFoundError, SendOperationStateError],
  receive: [ReceiveOperationNotFoundError, ReceiveOperationStateError],
} as const;

type OperationType = keyof typeof OPERATION_ERRORS;

export function operationNotFound(type: OperationType, cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: `The ${type[0]!.toUpperCase() + type.slice(1)} Operation does not exist`,
    retryable: false,
    cause,
  });
}

export function createOperationCocoErrorMapper(
  type: OperationType,
): (action: string, cause: unknown) => V1HttpError {
  const [notFoundError, stateError] = OPERATION_ERRORS[type];
  const label = type[0]!.toUpperCase() + type.slice(1);
  return (action, cause) => {
    if (cause instanceof notFoundError) return operationNotFound(type, cause);
    if (cause instanceof OperationInProgressError) {
      return new V1HttpError({
        status: 409,
        code: 'operation_in_progress',
        message: `The ${label} Operation is already in progress`,
        retryable: true,
        details: { type, operationId: cause.operationId },
        cause,
      });
    }
    if (cause instanceof stateError) {
      return new V1HttpError({
        status: 409,
        code: 'invalid_operation_state',
        message: `The ${label} Operation command is unavailable in its current state`,
        retryable: false,
        details: {
          type,
          operationId: cause.operationId,
          state: cause.state,
          expectedStates: [...cause.expectedStates],
        },
        cause,
      });
    }
    return cocoError(action, cause);
  };
}

export function quoteNotFound(type: 'Mint' | 'Melt'): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: `The ${type} Quote does not exist`,
    retryable: false,
  });
}

export function cocoError(action: string, cause: unknown): V1HttpError {
  if (cause instanceof V1HttpError) return cause;
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
    cause instanceof UnitValidationError ||
    cause instanceof ProofValidationError ||
    cause instanceof TokenValidationError ||
    cause instanceof MintQuoteValidationError
  ) {
    return new V1HttpError({
      status: 400,
      code: 'invalid_request',
      message: 'The Wallet request is invalid',
      retryable: false,
      cause,
    });
  }
  return new V1HttpError({
    status: 500,
    code: 'coco_error',
    message: `Coco could not ${action}`,
    retryable: false,
    cause,
  });
}
