import type { KeypairPurpose } from './Keypair.ts';

export { HttpResponseError, MintOperationError, NetworkError } from '@cashu/cashu-ts';

export class UnknownMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownMintError';
  }
}

export class MintFetchError extends Error {
  readonly mintUrl: string;
  constructor(mintUrl: string, message?: string, cause?: unknown) {
    super(message ?? `Failed to fetch mint ${mintUrl}`);
    this.name = 'MintFetchError';
    this.mintUrl = mintUrl;
    // Assign cause in a backwards compatible way without relying on ErrorOptions
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}

export class KeysetSyncError extends Error {
  readonly mintUrl: string;
  readonly keysetId: string;
  constructor(mintUrl: string, keysetId: string, message?: string, cause?: unknown) {
    super(message ?? `Failed to sync keyset ${keysetId} for mint ${mintUrl}`);
    this.name = 'KeysetSyncError';
    this.mintUrl = mintUrl;
    this.keysetId = keysetId;
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}

export class ProofValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofValidationError';
  }
}

export class MintQuoteValidationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MintQuoteValidationError';
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}

export class MintQuoteKeyError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MintQuoteKeyError';
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}

export class DerivationIndexExhaustedError extends Error {
  readonly purpose: KeypairPurpose;

  constructor(purpose: KeypairPurpose) {
    super(`No derivation indexes remain for keypair purpose ${purpose}`);
    this.name = 'DerivationIndexExhaustedError';
    this.purpose = purpose;
  }
}

export class UnitValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitValidationError';
  }
}

export class UnitMismatchError extends UnitValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'UnitMismatchError';
  }
}

export class TokenValidationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TokenValidationError';
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}

export class ProofOperationError extends Error {
  readonly mintUrl: string;
  readonly keysetId?: string;
  constructor(mintUrl: string, message?: string, keysetId?: string, cause?: unknown) {
    super(
      message ??
        `Proof operation failed for mint ${mintUrl}${keysetId ? ` keyset ${keysetId}` : ''}`,
    );
    this.name = 'ProofOperationError';
    this.mintUrl = mintUrl;
    this.keysetId = keysetId;
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}

/**
 * This error is thrown when a payment request is invalid or cannot be processed.
 */
export class PaymentRequestError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PaymentRequestError';
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}

/**
 * This error is thrown when attempting to modify an operation that is already in progress.
 */
export class OperationInProgressError extends Error {
  readonly operationId: string;
  constructor(operationId: string) {
    super(`Operation ${operationId} is already in progress`);
    this.name = 'OperationInProgressError';
    this.operationId = operationId;
  }
}

/**
 * A stale output keyset was rejected and the failed operation was safely rolled back.
 * Callers may create a new operation; the original operation must not be replayed.
 */
export class StaleKeysetError extends Error {
  readonly operationId: string;
  readonly mintUrl: string;
  readonly unit: string;
  readonly retryable = true;

  constructor(
    operationId: string,
    mintUrl: string,
    unit: string,
    message?: string,
    cause?: unknown,
  ) {
    super(message ?? `Operation ${operationId} used a stale keyset; create a new operation`);
    this.name = 'StaleKeysetError';
    this.operationId = operationId;
    this.mintUrl = mintUrl;
    this.unit = unit;
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}

/**
 * An operation could not establish a safe terminal outcome after an execution error.
 * Callers must not create a replacement operation until recovery resolves it.
 */
export class OperationRecoveryRequiredError extends Error {
  readonly operationId: string;
  readonly mintUrl: string;
  readonly unit: string;
  readonly retryable = false;

  constructor(
    operationId: string,
    mintUrl: string,
    unit: string,
    message?: string,
    cause?: unknown,
  ) {
    super(message ?? `Operation ${operationId} requires recovery before retrying`);
    this.name = 'OperationRecoveryRequiredError';
    this.operationId = operationId;
    this.mintUrl = mintUrl;
    this.unit = unit;
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}

export class AuthSessionError extends Error {
  readonly mintUrl: string;
  constructor(mintUrl: string, message?: string, cause?: unknown) {
    super(message ?? `Auth session error for mint ${mintUrl}`);
    this.name = 'AuthSessionError';
    this.mintUrl = mintUrl;
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}

export class AuthSessionExpiredError extends AuthSessionError {
  constructor(mintUrl: string) {
    super(mintUrl, `Auth session expired for mint ${mintUrl}`);
    this.name = `AuthSessionExpiredError`;
  }
}

export class QuoteIdentityConflictError extends Error {
  readonly kind: 'mint' | 'melt';
  readonly mintUrl: string;
  readonly quoteId: string;
  readonly methods: readonly string[];

  constructor(
    kind: 'mint' | 'melt',
    mintUrl: string,
    quoteId: string,
    methods: readonly string[],
    message?: string,
  ) {
    super(
      message ??
        `${kind} quote identity conflict for quote ${quoteId} at ${mintUrl}: methods ${methods.join(', ')}`,
    );
    this.name = 'QuoteIdentityConflictError';
    this.kind = kind;
    this.mintUrl = mintUrl;
    this.quoteId = quoteId;
    this.methods = [...methods];
  }
}
