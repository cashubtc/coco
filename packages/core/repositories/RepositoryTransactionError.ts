/**
 * Reports transient adapter contention while acquiring or committing a Wallet transaction.
 * Callers may apply a bounded retry policy to this error; domain and invariant errors must pass
 * through unchanged.
 */
export class RepositoryTransactionConflictError extends Error {
  readonly transient = true;

  constructor(message = 'Wallet repository transaction conflicted', cause?: unknown) {
    super(message);
    this.name = 'RepositoryTransactionConflictError';
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}
