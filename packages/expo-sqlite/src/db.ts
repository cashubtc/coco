// Minimal promise-based wrapper for expo-sqlite's async API
// Consumers pass an already opened database instance
import type { SQLiteDatabase } from 'expo-sqlite';

export type ExpoSqliteDatabaseLike = SQLiteDatabase;

export interface ExpoSqliteDbOptions {
  database: ExpoSqliteDatabaseLike;
}

export class ExpoSqliteDb {
  private readonly db: ExpoSqliteDatabaseLike;
  private transactionQueue: Promise<unknown> = Promise.resolve();

  constructor(options: ExpoSqliteDbOptions) {
    this.db = options.database;
  }

  get raw(): ExpoSqliteDatabaseLike {
    return this.db;
  }

  async exec(sql: string): Promise<void> {
    // execAsync can run multiple statements separated by semicolons
    await (this.db as any).execAsync(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
    const result = await (this.db as any).runAsync(sql, ...(params ?? []));
    return { lastID: result.lastInsertRowId ?? 0, changes: result.changes ?? 0 };
  }

  async get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const row = await (this.db as any).getFirstAsync(sql, ...(params ?? []));
    return (row ?? undefined) as T | undefined;
  }

  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = await (this.db as any).getAllAsync(sql, ...(params ?? []));
    return (rows ?? []) as T[];
  }

  async transaction<T>(fn: (tx: ExpoSqliteDb) => Promise<T>): Promise<T> {
    // Queue transactions to prevent concurrent/nested transaction attempts
    const previousTransaction = this.transactionQueue;
    let resolver: () => void;

    // Create a new promise that will be resolved when this transaction completes
    this.transactionQueue = new Promise<void>((resolve) => {
      resolver = resolve;
    });

    try {
      // Wait for the previous transaction to complete
      await previousTransaction;

      // Now execute our transaction
      const dbAny = this.db as any;

      if (typeof dbAny.withTransactionAsync === 'function') {
        let result!: T;
        await dbAny.withTransactionAsync(async () => {
          result = await fn(this);
        });
        return result;
      }

      await dbAny.execAsync('BEGIN');
      try {
        const res = await fn(this);
        await dbAny.execAsync('COMMIT');
        return res;
      } catch (error) {
        try {
          await dbAny.execAsync('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
        throw error;
      }
    } finally {
      // Signal that this transaction is done
      resolver!();
    }
  }
}

export function getUnixTimeSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
