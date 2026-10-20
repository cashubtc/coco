import { SqlTransactionConflictError } from './SqlTransactionConflictError.ts';
import { isSqliteTransactionConflict } from './utils.ts';

/** Internal native-driver error tracking; callback errors are never inferred from their text. */
export class SqliteDriverErrors {
  private readonly conflicts = new WeakSet<object>();

  async execute<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (typeof error === 'object' && error !== null && isSqliteTransactionConflict(error)) {
        this.conflicts.add(error);
      }
      throw error;
    }
  }

  /** Only call after failed BEGIN or successful ROLLBACK. */
  afterRollback(error: unknown): unknown {
    if (typeof error === 'object' && error !== null && this.conflicts.has(error)) {
      return new SqlTransactionConflictError(undefined, { cause: error });
    }
    return error;
  }
}
