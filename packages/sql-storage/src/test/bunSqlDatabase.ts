import type { Database, Statement } from 'bun:sqlite';
import type { SqlDatabase, SqlParams, SqlRunResult } from '../index.ts';

interface BunSqlDatabaseRootState {
  readonly database: Database;
  readonly statementCache: Map<string, Statement>;
  transactionQueue: Promise<void>;
  currentScope: symbol | null;
  scopeDepth: number;
  pendingTransactionCount: number;
}

export class BunSqlDatabase implements SqlDatabase {
  private readonly root: BunSqlDatabaseRootState;
  private readonly scopeToken: symbol | null;

  constructor(root: BunSqlDatabaseRootState, scopeToken: symbol | null = null) {
    this.root = root;
    this.scopeToken = scopeToken;
  }

  private getStatement(sql: string): Statement {
    let statement = this.root.statementCache.get(sql);
    if (!statement) {
      statement = this.root.database.prepare(sql);
      this.root.statementCache.set(sql, statement);
    }

    return statement;
  }

  private shouldWaitForTransaction(): boolean {
    return (
      this.root.pendingTransactionCount > 0 &&
      (!this.scopeToken || this.root.currentScope !== this.scopeToken)
    );
  }

  private async waitForActiveTransaction(): Promise<void> {
    while (this.shouldWaitForTransaction()) {
      await this.root.transactionQueue;
    }
  }

  async exec(sql: string): Promise<void> {
    if (this.shouldWaitForTransaction()) {
      await this.waitForActiveTransaction();
    }

    this.root.database.exec(sql);
  }

  async run(sql: string, params: SqlParams = []): Promise<SqlRunResult> {
    if (this.shouldWaitForTransaction()) {
      await this.waitForActiveTransaction();
    }

    const result = this.getStatement(sql).run(...params);

    return {
      lastInsertRowId: Number(result.lastInsertRowid),
      changes: result.changes,
    };
  }

  async get<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: SqlParams = [],
  ): Promise<Row | undefined> {
    if (this.shouldWaitForTransaction()) {
      await this.waitForActiveTransaction();
    }

    return (this.getStatement(sql).get(...params) ?? undefined) as Row | undefined;
  }

  async all<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: SqlParams = [],
  ): Promise<Row[]> {
    if (this.shouldWaitForTransaction()) {
      await this.waitForActiveTransaction();
    }

    return this.getStatement(sql).all(...params) as Row[];
  }

  async transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> {
    const { root } = this;

    if (this.scopeToken && root.currentScope === this.scopeToken) {
      root.scopeDepth++;
      try {
        return await fn(this);
      } finally {
        root.scopeDepth--;
      }
    }

    const scopeToken = Symbol('bun-sql-test-transaction');
    const scopedDatabase = new BunSqlDatabase(root, scopeToken);
    const previousTransaction = root.transactionQueue;
    let releaseTransaction!: () => void;

    root.transactionQueue = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    root.pendingTransactionCount++;

    try {
      await previousTransaction;

      root.currentScope = scopeToken;
      root.scopeDepth = 1;
      await scopedDatabase.exec('BEGIN');

      try {
        const result = await fn(scopedDatabase);
        await scopedDatabase.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          await scopedDatabase.exec('ROLLBACK');
        } catch {
          // Ignore rollback errors so the original transaction error is preserved.
        }

        throw error;
      }
    } finally {
      root.scopeDepth = 0;
      root.currentScope = null;
      root.pendingTransactionCount--;
      releaseTransaction();
    }
  }
}

export function createBunSqlDatabase(database: Database): BunSqlDatabase {
  return new BunSqlDatabase({
    database,
    statementCache: new Map(),
    transactionQueue: Promise.resolve(),
    currentScope: null,
    scopeDepth: 0,
    pendingTransactionCount: 0,
  });
}
