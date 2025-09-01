// Minimal promise-based wrapper for expo-sqlite's async API
// Consumers pass an already opened database instance
import type { SQLiteDatabase } from 'expo-sqlite';

export type ExpoSqliteDatabaseLike = SQLiteDatabase;

export interface ExpoSqliteDbOptions {
  database: ExpoSqliteDatabaseLike;
}

export class ExpoSqliteDb {
  private readonly db: ExpoSqliteDatabaseLike;

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
    const dbAny = this.db as any;
    if (typeof dbAny.withTransactionAsync === 'function') {
      let result!: T;
      await dbAny.withTransactionAsync(async () => {
        result = await fn(this);
      });
      return result;
    }
    await (this.db as any).execAsync('BEGIN');
    try {
      const res = await fn(this);
      await (this.db as any).execAsync('COMMIT');
      return res;
    } catch (error) {
      try {
        await (this.db as any).execAsync('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw error;
    }
  }
}

export function getUnixTimeSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
