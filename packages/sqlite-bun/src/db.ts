import type { Database, Statement } from 'bun:sqlite';

export interface SqliteDbOptions {
  database: Database;
}

/**
 * Shared state for transaction management across all SqliteDb instances.
 * All instances created from the same root share this state to coordinate transactions.
 */
interface SqliteDbRootState {
  /** The underlying bun:sqlite Database instance */
  readonly db: Database;
  /** Promise chain used to serialize concurrent transactions */
  transactionQueue: Promise<void>;
  /** Unique identifier for the currently active transaction scope (null if no transaction) */
  currentScope: symbol | null;
  /** Current nesting depth of transactions (1 = top-level, 2+ = nested) */
  scopeDepth: number;
  /** Cache of prepared statements for frequently-used queries */
  statementCache: Map<string, Statement>;
}

/**
 * Wrapper around bun:sqlite.Database providing async/await API and transaction management.
 *
 * Transaction behavior:
 * - Nested transactions within the same scope are "rolled up" - they reuse the parent transaction
 * - Concurrent transactions from different scopes are queued and executed serially
 * - Each top-level transaction gets a unique scope token for identification
 */
export class SqliteDb {
  private readonly root: SqliteDbRootState;
  /** Unique identifier for this instance's transaction scope (null for root instances) */
  private readonly scopeToken: symbol | null;

  constructor(
    optionsOrRoot: SqliteDbOptions | SqliteDbRootState,
    scopeToken: symbol | null = null,
  ) {
    if ('database' in optionsOrRoot) {
      // Creating a root instance - initialize the shared state
      this.root = {
        db: optionsOrRoot.database,
        transactionQueue: Promise.resolve(),
        currentScope: null,
        scopeDepth: 0,
        statementCache: new Map(),
      } satisfies SqliteDbRootState;
      this.scopeToken = null;
    } else {
      // Creating a scoped instance - share the root state
      this.root = optionsOrRoot;
      this.scopeToken = scopeToken;
    }
  }

  get raw(): Database {
    return this.root.db;
  }

  /**
   * Get a cached prepared statement for the given SQL.
   * Creates and caches the statement if it doesn't exist.
   */
  private getCachedStatement(sql: string): Statement {
    const { statementCache } = this.root;
    let statement = statementCache.get(sql);
    if (!statement) {
      statement = this.root.db.prepare(sql);
      statementCache.set(sql, statement);
    }
    return statement;
  }

  exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.root.db.exec(sql);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  run(sql: string, params: any[] = []): Promise<{ lastID: number; changes: number }> {
    return new Promise((resolve, reject) => {
      try {
        const statement = this.getCachedStatement(sql);
        const result = statement.run(...params);
        resolve({
          lastID: Number(result.lastInsertRowid),
          changes: result.changes,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  get<T = unknown>(sql: string, params: any[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      try {
        const statement = this.getCachedStatement(sql);
        const result = statement.get(...params) as T | undefined;
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  all<T = unknown>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      try {
        const statement = this.getCachedStatement(sql);
        const result = statement.all(...params) as T[];
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Execute a function within a database transaction.
   *
   * Transaction Semantics:
   *
   * 1. NESTED TRANSACTIONS (same scope):
   *    When transaction() is called from within an active transaction using the same
   *    scoped SqliteDb instance, the inner call is treated as part of the outer transaction.
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
   * @param fn - Function to execute within the transaction, receives a scoped SqliteDb instance
   * @returns Promise that resolves with the return value of fn
   * @throws Re-throws any error from fn after rolling back the transaction
   */
  async transaction<T>(fn: (tx: SqliteDb) => Promise<T>): Promise<T> {
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
    const scopeToken = Symbol('bun-sqlite-transaction');
    const scopedDb = new SqliteDb(root, scopeToken);

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
      // Use .catch() to prevent unhandled rejection warnings while preserving error for debugging
      await previousTransaction.catch((error) => {
        // Log error from previous transaction but continue with current transaction
        // Previous transaction errors are handled by their respective callers
        console.warn('Previous transaction failed:', error);
      });

      // EXECUTE TRANSACTION:
      // Mark this scope as active and issue BEGIN
      root.currentScope = scopeToken;
      root.scopeDepth = 1;
      await scopedDb.exec('BEGIN');

      try {
        // Execute user code within the transaction
        const result = await fn(scopedDb);
        // Success - commit the transaction
        await scopedDb.exec('COMMIT');
        return result;
      } catch (error) {
        // Error - rollback the transaction
        try {
          await scopedDb.exec('ROLLBACK');
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

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.root.db.close();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }
}

export function getUnixTimeSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
