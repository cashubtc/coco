import {
  UnknownMintError,
  ProofValidationError,
  TokenValidationError,
  MintQuoteValidationError,
  OperationInProgressError,
  PaymentRequestError,
  UnitValidationError,
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

interface OperationStateMappingError extends Error {
  readonly operationId: string;
  readonly state: string;
  readonly expectedStates: readonly string[];
}

type OperationErrorConstructor<T extends Error> = abstract new (...args: never[]) => T;

export function createOperationCocoErrorMapper({
  type,
  label,
  notFoundError,
  stateError,
  notFound,
}: {
  type: 'mint' | 'melt' | 'send' | 'receive';
  label: 'Mint' | 'Melt' | 'Send' | 'Receive';
  notFoundError: OperationErrorConstructor<Error>;
  stateError: OperationErrorConstructor<OperationStateMappingError>;
  notFound: (cause?: unknown) => V1HttpError;
}): (action: string, cause: unknown) => V1HttpError {
  return (action, cause) => {
    if (cause instanceof notFoundError) return notFound(cause);
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
