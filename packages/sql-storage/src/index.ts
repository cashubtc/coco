export type SqlValue = string | number | bigint | Uint8Array | null;

export type SqlParams = readonly SqlValue[];

export interface SqlRunResult {
  readonly lastInsertRowId: number;
  readonly changes: number;
}

export interface SqlDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParams): Promise<SqlRunResult>;
  get<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
  ): Promise<Row | undefined>;
  all<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
  ): Promise<Row[]>;
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}
