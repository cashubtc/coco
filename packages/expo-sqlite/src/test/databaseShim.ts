import { Database } from 'bun:sqlite';

type RunResult = { changes: number; lastInsertRowId: number; lastInsertRowid: number };

export class BunExpoSqliteDatabaseShim {
  private readonly db: Database;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
  }

  async execAsync(sql: string): Promise<void> {
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statementSql of statements) {
      const statement = this.db.prepare(statementSql);
      statement.run();
    }
  }

  async runAsync(sql: string, ...params: any[]): Promise<RunResult> {
    const statement = this.db.prepare(sql);
    const result = statement.run(...params) as unknown as {
      changes?: number;
      lastInsertRowid?: number;
    };
    const changes = Number(result?.changes ?? 0);
    const lastInsertRowId = Number(result?.lastInsertRowid ?? 0);
    return { changes, lastInsertRowId, lastInsertRowid: lastInsertRowId };
  }

  async getFirstAsync<T = unknown>(sql: string, ...params: any[]): Promise<T | null> {
    const statement = this.db.prepare(sql);
    const row = statement.get(...params) as T | undefined;
    return row ?? null;
  }

  async getAllAsync<T = unknown>(sql: string, ...params: any[]): Promise<T[]> {
    const statement = this.db.prepare(sql);
    const rows = statement.all(...params) as T[] | undefined;
    return rows ?? [];
  }

  async closeAsync(): Promise<void> {
    this.db.close();
  }
}

export class WebExpoSqliteDatabaseShim extends BunExpoSqliteDatabaseShim {
  exclusiveTransactionCalls = 0;
  transactionCalls = 0;

  async withExclusiveTransactionAsync(): Promise<void> {
    this.exclusiveTransactionCalls++;
    throw new Error('withExclusiveTransactionAsync is not supported on web');
  }

  async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
    this.transactionCalls++;
    await this.execAsync('BEGIN');
    try {
      await fn();
      await this.execAsync('COMMIT');
    } catch (error) {
      await this.execAsync('ROLLBACK');
      throw error;
    }
  }
}

export class NativeExpoSqliteDatabaseShim extends BunExpoSqliteDatabaseShim {
  exclusiveTransactionCalls = 0;
  transactionCalls = 0;
  executedSql: string[] = [];

  override async execAsync(sql: string): Promise<void> {
    this.executedSql.push(sql);
    await super.execAsync(sql);
  }

  async withExclusiveTransactionAsync(fn: (txn: BunExpoSqliteDatabaseShim) => Promise<void>) {
    this.exclusiveTransactionCalls++;
    await this.execAsync('BEGIN');
    try {
      await fn(this);
      await this.execAsync('COMMIT');
    } catch (error) {
      await this.execAsync('ROLLBACK');
      throw error;
    }
  }

  async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
    this.transactionCalls++;
    await this.execAsync('BEGIN');
    try {
      await fn();
      await this.execAsync('COMMIT');
    } catch (error) {
      await this.execAsync('ROLLBACK');
      throw error;
    }
  }
}
