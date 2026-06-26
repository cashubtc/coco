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
 * This error is thrown when a HTTP response is not 2XX nor a protocol error.
 */
export class HttpResponseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'HttpResponseError';
    Object.setPrototypeOf(this, HttpResponseError.prototype);
  }
}

/**
 * This error is thrown when a network request fails.
 */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

/**
 * This error is thrown when a protocol error occurs per Cashu NUT-00 error codes.
 */
export class MintOperationError extends HttpResponseError {
  code: number;
  constructor(code: number, detail: string) {
    super(detail || 'Unknown mint operation error', 400);
    this.code = code;
    this.name = 'MintOperationError';
    Object.setPrototypeOf(this, MintOperationError.prototype);
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

export class QuoteNotFoundError extends Error {
  readonly kind: 'mint' | 'melt';
  readonly mintUrl: string;
  readonly quoteId: string;

  constructor(kind: 'mint' | 'melt', mintUrl: string, quoteId: string, message?: string) {
    super(message ?? `${kind} quote ${quoteId} at ${mintUrl} was not found`);
    this.name = 'QuoteNotFoundError';
    this.kind = kind;
    this.mintUrl = mintUrl;
    this.quoteId = quoteId;
  }
}

export class QuoteWaitTimeoutError extends Error {
  readonly kind: 'mint' | 'melt';
  readonly mintUrl: string;
  readonly quoteId: string;
  readonly timeoutMs: number;

  constructor(kind: 'mint' | 'melt', mintUrl: string, quoteId: string, timeoutMs: number) {
    super(`${kind} quote ${quoteId} at ${mintUrl} did not update within ${timeoutMs}ms`);
    this.name = 'QuoteWaitTimeoutError';
    this.kind = kind;
    this.mintUrl = mintUrl;
    this.quoteId = quoteId;
    this.timeoutMs = timeoutMs;
  }
}

export class QuoteWaitAbortedError extends Error {
  readonly kind: 'mint' | 'melt';
  readonly mintUrl: string;
  readonly quoteId: string;

  constructor(kind: 'mint' | 'melt', mintUrl: string, quoteId: string, reason?: unknown) {
    super(`${kind} quote ${quoteId} at ${mintUrl} wait was aborted`);
    this.name = 'QuoteWaitAbortedError';
    this.kind = kind;
    this.mintUrl = mintUrl;
    this.quoteId = quoteId;
    (this as unknown as { cause?: unknown }).cause = reason;
  }
}

export class TerminalQuoteStateError extends Error {
  readonly kind: 'mint' | 'melt';
  readonly mintUrl: string;
  readonly quoteId: string;
  readonly state: string;

  constructor(
    kind: 'mint' | 'melt',
    mintUrl: string,
    quoteId: string,
    state: string,
    message?: string,
  ) {
    super(message ?? `${kind} quote ${quoteId} at ${mintUrl} is terminal: ${state}`);
    this.name = 'TerminalQuoteStateError';
    this.kind = kind;
    this.mintUrl = mintUrl;
    this.quoteId = quoteId;
    this.state = state;
  }
}
