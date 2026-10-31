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

/** The mint served keys that are not the keys its advertised keyset id commits to. */
export class KeysetVerificationError extends KeysetSyncError {
  constructor(mintUrl: string, keysetId: string, message: string, cause?: unknown) {
    super(mintUrl, keysetId, message, cause);
    this.name = 'KeysetVerificationError';
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

/** Raised when a Melt Quote cannot back the requested Melt, such as an unknown fee option. */
export class MeltQuoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeltQuoteValidationError';
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

/** Operation families whose lifecycle commands report typed lookup and state failures. */
export type LifecycleOperationType = 'mint' | 'melt' | 'send' | 'receive';

/** Raised when a lifecycle command targets an Operation ID that does not exist. */
export class OperationNotFoundError extends Error {
  constructor(
    readonly operationType: LifecycleOperationType,
    readonly operationId: string,
  ) {
    super(`Operation ${operationId} not found`);
    this.name = 'OperationNotFoundError';
  }
}

/** Current and accepted states of an Operation whose lifecycle command was rejected. */
export interface OperationStateErrorDetails {
  operationType: LifecycleOperationType;
  operationId: string;
  state: string;
  expectedStates: readonly string[];
  /** Set when the Melt Quote's state, not the Operation's own state, blocks the command. */
  quoteState?: string;
}

/**
 * Raised when a lifecycle command is unavailable in the Operation's current state.
 *
 * The state is the one observed when the command was rejected, so callers should re-read the
 * Operation before choosing another command. `quoteState` is set when the Operation's own state
 * accepts the command but its Melt Quote's state does not.
 */
export class OperationStateError extends Error {
  readonly operationType: LifecycleOperationType;
  readonly operationId: string;
  readonly state: string;
  readonly expectedStates: readonly string[];
  readonly quoteState?: string;

  constructor(details: OperationStateErrorDetails, message: string) {
    super(message);
    this.name = 'OperationStateError';
    this.operationType = details.operationType;
    this.operationId = details.operationId;
    this.state = details.state;
    this.expectedStates = [...details.expectedStates];
    this.quoteState = details.quoteState;
  }
}

export class SendOperationConflictError extends Error {
  readonly operationId: string;

  constructor(operationId: string, message?: string) {
    super(message ?? `Send operation ${operationId} changed concurrently`);
    this.name = 'SendOperationConflictError';
    this.operationId = operationId;
  }
}

export class ReceiveOperationConflictError extends Error {
  constructor(
    readonly operationId: string,
    message?: string,
  ) {
    super(message ?? `Receive operation ${operationId} changed concurrently`);
    this.name = 'ReceiveOperationConflictError';
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

export class KeysetKeysConflictError extends Error {
  readonly mintUrl: string;
  readonly keysetId: string;

  constructor(mintUrl: string, keysetId: string) {
    super(
      `Keyset ${keysetId} for mint ${mintUrl} is already stored with different keys; ` +
        `a keyset id commits to its keys and they cannot change`,
    );
    this.name = 'KeysetKeysConflictError';
    this.mintUrl = mintUrl;
    this.keysetId = keysetId;
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
