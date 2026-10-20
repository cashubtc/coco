const conflictBrand = Symbol.for('@cashu/coco/sql-transaction-conflict');

/**
 * A transaction attempt did not commit and rollback has completed (or BEGIN failed).
 * Drivers must never use this error for an uncertain commit outcome. Coco owns retries.
 */
export class SqlTransactionConflictError extends Error {
  // Duplicate compatible installations must preserve retry classification.
  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { [conflictBrand]?: boolean })[conflictBrand] === true
    );
  }

  constructor(message = 'SQLite transaction conflicted', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SqlTransactionConflictError';
    Object.defineProperty(this, conflictBrand, { value: true });
  }
}
