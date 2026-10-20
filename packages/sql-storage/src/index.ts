export type SqlValue = string | number | bigint | Uint8Array | null;

export type SqlParams = readonly SqlValue[];

export interface SqlRunResult {
  readonly lastInsertRowId: number;
  readonly changes: number;
}

export interface SqlTransactionOptions {
  mode?: 'deferred' | 'immediate';
}

/** SQLite execution contract. See the package README for transaction and ownership guarantees. */
export interface SqlDatabase {
  /** Maximum bound values per statement, including fixed values. Defaults to 999; minimum 32. */
  readonly maxParameters?: number;
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParams): Promise<SqlRunResult>;
  get<Row extends object = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
  ): Promise<Row | undefined>;
  all<Row extends object = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
  ): Promise<Row[]>;
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>, options?: SqlTransactionOptions): Promise<T>;
}

export { createSqliteStorage, type SqliteStorageOptions } from './storage.ts';
export { SqlTransactionConflictError } from './SqlTransactionConflictError.ts';
