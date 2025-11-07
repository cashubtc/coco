// Minimal promise-based wrapper for expo-sqlite's async API
// Consumers pass an already opened database instance
import type { SQLiteDatabase } from 'expo-sqlite';

export type ExpoSqliteDatabaseLike = SQLiteDatabase;

export interface ExpoSqliteDbOptions {
  database: ExpoSqliteDatabaseLike;
}

/**
 * Shared state for transaction management across all ExpoSqliteDb instances.
 * All instances created from the same root share this state to coordinate transactions.
 */
interface ExpoSqliteDbRootState {
  /** The underlying expo-sqlite Database instance */
  readonly db: ExpoSqliteDatabaseLike;
  /** Promise chain used to serialize concurrent transactions */
  transactionQueue: Promise<void>;
  /** Unique identifier for the currently active transaction scope (null if no transaction) */
  currentScope: symbol | null;
  /** Current nesting depth of transactions (1 = top-level, 2+ = nested) */
  scopeDepth: number;
}

/**
 * Wrapper around expo-sqlite Database providing transaction management.
 *
 * Transaction behavior:
 * - Nested transactions within the same scope are "rolled up" - they reuse the parent transaction
 * - Concurrent transactions from different scopes are queued and executed serially
 * - Each top-level transaction gets a unique scope token for identification
 */
export class ExpoSqliteDb {
  private readonly root: ExpoSqliteDbRootState;
  /** Unique identifier for this instance's transaction scope (null for root instances) */
  private readonly scopeToken: symbol | null;

  constructor(
    optionsOrRoot: ExpoSqliteDbOptions | ExpoSqliteDbRootState,
    scopeToken: symbol | null = null,
  ) {
    if ('database' in optionsOrRoot) {
      // Creating a root instance - initialize the shared state
      this.root = {
        db: optionsOrRoot.database,
        transactionQueue: Promise.resolve(),
        currentScope: null,
        scopeDepth: 0,
      } satisfies ExpoSqliteDbRootState;
      this.scopeToken = null;
    } else {
      // Creating a scoped instance - share the root state
      this.root = optionsOrRoot;
      this.scopeToken = scopeToken;
    }
  }

  get raw(): ExpoSqliteDatabaseLike {
    return this.root.db;
  }

  async exec(sql: string): Promise<void> {
    // execAsync can run multiple statements separated by semicolons
    await (this.root.db as any).execAsync(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
    const result = await (this.root.db as any).runAsync(sql, ...(params ?? []));
    return { lastID: result.lastInsertRowId ?? 0, changes: result.changes ?? 0 };
  }

  async get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const row = await (this.root.db as any).getFirstAsync(sql, ...(params ?? []));
    return (row ?? undefined) as T | undefined;
  }

  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = await (this.root.db as any).getAllAsync(sql, ...(params ?? []));
    return (rows ?? []) as T[];
  }

  /**
   * Execute a function within a database transaction.
   *
   * Transaction Semantics:
   *
   * 1. NESTED TRANSACTIONS (same scope):
   *    When transaction() is called from within an active transaction using the same
   *    scoped ExpoSqliteDb instance, the inner call is treated as part of the outer transaction.
   *    No new BEGIN/COMMIT is issued - the transaction is "rolled up".
   *
   * 2. CONCURRENT TRANSACTIONS (different scopes):
   *    When transaction() is called while another transaction is active but from a
   *    different scope (e.g., parallel calls), the new transaction waits in a queue.
   *    Transactions execute serially to prevent "cannot start a transaction within a transaction".
   *
   * 3. ERROR HANDLING:
   *    If the transaction function throws an error, ROLLBACK is executed and the error
   *    is re-thrown. The transaction queue is properly released even on error, allowing
   *    subsequent transactions to proceed.
   *
   * @param fn - Function to execute within the transaction, receives a scoped ExpoSqliteDb instance
   * @returns Promise that resolves with the return value of fn
   * @throws Re-throws any error from fn after rolling back the transaction
   */
  async transaction<T>(fn: (tx: ExpoSqliteDb) => Promise<T>): Promise<T> {
    const { root } = this;

    // NESTED TRANSACTION DETECTION:
    // Check if we're already inside a transaction with this scope token
    if (this.scopeToken && root.currentScope === this.scopeToken) {
      // We're nested - increment depth for tracking and execute fn with same instance
      // No BEGIN/COMMIT issued - this is rolled up into the parent transaction
      root.scopeDepth++;
      try {
        return await fn(this);
      } finally {
        root.scopeDepth--;
      }
    }

    // NEW TRANSACTION: Create a unique scope token and scoped instance
    const scopeToken = Symbol('expo-sqlite-transaction');
    const scopedDb = new ExpoSqliteDb(root, scopeToken);

    // TRANSACTION QUEUE SETUP:
    // Save reference to the previous transaction's completion promise
    const previousTransaction = root.transactionQueue;
    let resolver!: () => void;

    // Create a new promise that will be resolved when THIS transaction completes
    // This becomes the "previous" transaction for the next transaction that starts
    root.transactionQueue = new Promise<void>((resolve) => {
      resolver = resolve;
    });

    try {
      // SERIALIZATION: Wait for the previous transaction to complete
      // This ensures only one transaction executes at a time
      await previousTransaction;

      // EXECUTE TRANSACTION:
      // Mark this scope as active
      const dbAny = root.db as any;
      root.currentScope = scopeToken;
      root.scopeDepth = 1;

      // Prefer withTransactionAsync if available (newer expo-sqlite versions)
      // This provides better transaction handling with automatic rollback on error
      if (typeof dbAny.withTransactionAsync === 'function') {
        let result!: T;
        await dbAny.withTransactionAsync(async () => {
          result = await fn(scopedDb);
        });
        return result;
      }

      // Fallback to manual BEGIN/COMMIT for older versions
      await dbAny.execAsync('BEGIN');
      try {
        // Execute user code within the transaction
        const res = await fn(scopedDb);
        // Success - commit the transaction
        await dbAny.execAsync('COMMIT');
        return res;
      } catch (error) {
        // Error - rollback the transaction
        try {
          await dbAny.execAsync('ROLLBACK');
        } catch {
          // Ignore rollback errors (e.g., if transaction already rolled back)
        }
        throw error;
      }
    } finally {
      // CLEANUP: Always clear the current scope and release the queue
      // This allows the next queued transaction to proceed
      root.scopeDepth = 0;
      root.currentScope = null;
      resolver(); // Critical: This unblocks the next transaction in the queue
    }
  }
}

export function getUnixTimeSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
