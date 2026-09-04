import { describe, expect, it } from 'bun:test';
import { RepositoryTransactionConflictError } from '@cashu/coco-core/adapter';
import type { SqlDatabase, SqlParams, SqlRunResult, SqlTransactionOptions } from '../index.ts';
import { SqlStorageRepositories } from '../repositories.ts';

class PassthroughSqlDatabase implements SqlDatabase {
  async exec(): Promise<void> {}

  async run(): Promise<SqlRunResult> {
    return { lastInsertRowId: 0, changes: 0 };
  }

  async get<Row extends object>(_sql: string, _params?: SqlParams): Promise<Row | undefined> {
    return undefined;
  }

  async all<Row extends object>(_sql: string, _params?: SqlParams): Promise<Row[]> {
    return [];
  }

  async transaction<T>(
    fn: (tx: SqlDatabase) => Promise<T>,
    _options?: SqlTransactionOptions,
  ): Promise<T> {
    return fn(this);
  }
}

describe('SqlStorageRepositories transaction errors', () => {
  it('maps driver-coded callback lock errors to a typed transient conflict', async () => {
    const repositories = new SqlStorageRepositories({ database: new PassthroughSqlDatabase() });
    const lockedError = Object.assign(new Error('statement failed'), { code: 'SQLITE_LOCKED' });

    await expect(
      repositories.withTransaction(async () => {
        throw lockedError;
      }),
    ).rejects.toBeInstanceOf(RepositoryTransactionConflictError);
  });
});
