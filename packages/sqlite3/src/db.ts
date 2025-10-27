export interface DatabaseLike {
  exec(sql: string, cb: (err: Error | null) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(
    sql: string,
    params: any[],
    cb: (this: { lastID: number; changes: number }, err: Error | null) => void,
  ): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(sql: string, params: any[], cb: (err: Error | null, row: any) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all(sql: string, params: any[], cb: (err: Error | null, rows: any[]) => void): void;
  close(cb: (err: Error | null) => void): void;
}

export interface SqliteDbOptions {
  database: DatabaseLike;
}

export class SqliteDb {
  private readonly db: DatabaseLike;
  private transactionQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SqliteDbOptions) {
    this.db = options.database;
  }

  get raw(): DatabaseLike {
    return this.db;
  }

  exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err: Error | null) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  run(sql: string, params: any[] = []): Promise<{ lastID: number; changes: number }> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.db as any).run(
        sql,
        params,
        function (this: { lastID: number; changes: number }, err: Error | null) {
          if (err) return reject(err);
          resolve({ lastID: this.lastID, changes: this.changes });
        },
      );
    });
  }

  get<T = unknown>(sql: string, params: any[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.db as any).get(sql, params, (err: Error | null, row: T | undefined) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  }

  all<T = unknown>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.db as any).all(sql, params, (err: Error | null, rows: T[]) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }

  async transaction<T>(fn: (tx: SqliteDb) => Promise<T>): Promise<T> {
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
      await this.exec('BEGIN');
      try {
        const result = await fn(this);
        await this.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          await this.exec('ROLLBACK');
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

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err: Error | null) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}

export function getUnixTimeSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
