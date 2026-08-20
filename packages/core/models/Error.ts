import type { MintOperationState } from '../operations/mint/MintOperation.ts';
import type { SendOperationState } from '../operations/send/SendOperation.ts';
import type { ReceiveOperationState } from '../operations/receive/ReceiveOperation.ts';
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

/** Raised when a requested Mint Operation does not exist. */
export class MintOperationNotFoundError extends Error {
  constructor(readonly operationId: string) {
    super(`Operation ${operationId} not found`);
    this.name = 'MintOperationNotFoundError';
  }
}

/** Raised when a Mint lifecycle command is unavailable in the current state. */
export class MintOperationStateError extends Error {
  readonly expectedStates: readonly MintOperationState[];

  constructor(
    readonly operationId: string,
    readonly state: MintOperationState,
    expectedStates: readonly MintOperationState[],
  ) {
    const expected = expectedStates.map((expectedState) => `'${expectedState}'`).join(' or ');
    super(`Cannot modify operation in state '${state}'. Expected ${expected}.`);
    this.name = 'MintOperationStateError';
    this.expectedStates = [...expectedStates];
  }
}

/** Raised when a requested Send Operation does not exist. */
export class SendOperationNotFoundError extends Error {
  constructor(readonly operationId: string) {
    super(`Operation ${operationId} not found`);
    this.name = 'SendOperationNotFoundError';
  }
}

/** Raised when a Send lifecycle command is unavailable in the current state. */
export class SendOperationStateError extends Error {
  readonly expectedStates: readonly SendOperationState[];

  constructor(
    readonly operationId: string,
    readonly state: SendOperationState,
    expectedStates: readonly SendOperationState[],
  ) {
    const expected = expectedStates.map((expectedState) => `'${expectedState}'`).join(' or ');
    super(`Cannot modify operation in state '${state}'. Expected ${expected}.`);
    this.name = 'SendOperationStateError';
    this.expectedStates = [...expectedStates];
  }
}

/** Raised when a requested Receive Operation does not exist. */
export class ReceiveOperationNotFoundError extends Error {
  constructor(readonly operationId: string) {
    super(`Operation ${operationId} not found`);
    this.name = 'ReceiveOperationNotFoundError';
  }
}

/** Raised when a Receive lifecycle command is unavailable in the current state. */
export class ReceiveOperationStateError extends Error {
  readonly expectedStates: readonly ReceiveOperationState[];

  constructor(
    readonly operationId: string,
    readonly state: ReceiveOperationState,
    expectedStates: readonly ReceiveOperationState[],
  ) {
    const expected = expectedStates.map((expectedState) => `'${expectedState}'`).join(' or ');
    super(`Cannot modify operation in state '${state}'. Expected ${expected}.`);
    this.name = 'ReceiveOperationStateError';
    this.expectedStates = [...expectedStates];
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
