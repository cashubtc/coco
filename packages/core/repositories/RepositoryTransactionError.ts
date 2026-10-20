const conflictBrand = Symbol.for('@cashu/coco/repository-transaction-conflict');

/**
 * Reports transient adapter contention while acquiring or committing a Wallet transaction.
 * Callers may apply a bounded retry policy to this error; domain and invariant errors must pass
 * through unchanged.
 */
export class RepositoryTransactionConflictError extends Error {
  // Duplicate compatible installations must preserve retry classification.
  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { [conflictBrand]?: boolean })[conflictBrand] === true
    );
  }

  readonly transient = true;

  constructor(message = 'Wallet repository transaction conflicted', cause?: unknown) {
    super(message);
    this.name = 'RepositoryTransactionConflictError';
    Object.defineProperty(this, conflictBrand, { value: true });
    (this as unknown as { cause?: unknown }).cause = cause;
  }
}
