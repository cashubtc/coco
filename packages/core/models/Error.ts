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
export class TokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenValidationError';
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
