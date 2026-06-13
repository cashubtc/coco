import type { SqlDatabase } from '../index.ts';

export interface SqlDatabaseTestHandle {
  readonly database: SqlDatabase;
  dispose?(): void | Promise<void>;
}

export interface SqlDatabaseContractOptions {
  createDatabase(): SqlDatabaseTestHandle | Promise<SqlDatabaseTestHandle>;
}

type TestResult = void | Promise<void>;

interface Matcher {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toHaveLength(expected: number): void;
}

interface Expect {
  (actual: unknown): Matcher;
}

export interface SqlDatabaseContractTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => TestResult, timeout?: number): void;
  expect: Expect;
}

async function withDatabase<T>(
  options: SqlDatabaseContractOptions,
  fn: (database: SqlDatabase) => Promise<T>,
): Promise<T> {
  const handle = await options.createDatabase();
  try {
    return await fn(handle.database);
  } finally {
    await handle.dispose?.();
  }
}

async function expectRejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject } as const;
}

export function runSqlDatabaseContract(
  options: SqlDatabaseContractOptions,
  api: SqlDatabaseContractTestApi,
): void {
  const { describe, expect, it } = api;

  describe('SQL database driver contract', () => {
    it('executes multiple statements with exec', async () => {
      await withDatabase(options, async (database) => {
        await database.exec(`
          CREATE TABLE contract_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL
          );

          INSERT INTO contract_items (label) VALUES ('alpha');
          INSERT INTO contract_items (label) VALUES ('beta');
        `);

        const rows = await database.all<{ label: string }>(
          'SELECT label FROM contract_items ORDER BY id ASC',
        );

        expect(rows).toEqual([{ label: 'alpha' }, { label: 'beta' }]);
      });
    });

    it('binds readonly positional parameters', async () => {
      await withDatabase(options, async (database) => {
        await database.exec(`
          CREATE TABLE contract_params (
            text_value TEXT NOT NULL,
            number_value INTEGER NOT NULL,
            bigint_value INTEGER NOT NULL,
            bytes_value BLOB NOT NULL,
            null_value TEXT
          );
        `);

        const params = ['alpha', 7, 9n, new Uint8Array([1, 2, 3]), null] as const;
        await database.run(
          `INSERT INTO contract_params
            (text_value, number_value, bigint_value, bytes_value, null_value)
           VALUES (?, ?, ?, ?, ?)`,
          params,
        );

        const row = await database.get<{
          text_value: string;
          number_value: number;
          bigint_value: number;
          bytes_length: number;
          null_value: null;
        }>(
          `SELECT
             text_value,
             number_value,
             bigint_value,
             LENGTH(bytes_value) AS bytes_length,
             null_value
           FROM contract_params`,
        );

        expect(row).toEqual({
          text_value: 'alpha',
          number_value: 7,
          bigint_value: 9,
          bytes_length: 3,
          null_value: null,
        });
      });
    });

    it('normalizes run results', async () => {
      await withDatabase(options, async (database) => {
        await database.exec(`
          CREATE TABLE contract_run_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL
          );
        `);

        const insertResult = await database.run(
          'INSERT INTO contract_run_results (label) VALUES (?)',
          ['alpha'],
        );
        const updateResult = await database.run(
          'UPDATE contract_run_results SET label = ? WHERE id = ?',
          ['beta', insertResult.lastInsertRowId],
        );

        expect(insertResult.lastInsertRowId).toBe(1);
        expect(insertResult.changes).toBe(1);
        expect(updateResult.changes).toBe(1);
      });
    });

    it('returns one row from get and all rows from all', async () => {
      await withDatabase(options, async (database) => {
        await database.exec(`
          CREATE TABLE contract_query_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL
          );

          INSERT INTO contract_query_results (label) VALUES ('alpha');
          INSERT INTO contract_query_results (label) VALUES ('beta');
        `);

        const first = await database.get<{ label: string }>(
          'SELECT label FROM contract_query_results ORDER BY id ASC',
        );
        const missing = await database.get<{ label: string }>(
          'SELECT label FROM contract_query_results WHERE label = ?',
          ['missing'],
        );
        const all = await database.all<{ label: string }>(
          'SELECT label FROM contract_query_results ORDER BY id ASC',
        );

        expect(first).toEqual({ label: 'alpha' });
        expect(missing).toBe(undefined);
        expect(all).toEqual([{ label: 'alpha' }, { label: 'beta' }]);
      });
    });

    it('commits successful transactions', async () => {
      await withDatabase(options, async (database) => {
        await database.exec(`
          CREATE TABLE contract_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL
          );
        `);

        await database.transaction(async (tx) => {
          await tx.run('INSERT INTO contract_transactions (label) VALUES (?)', ['alpha']);
        });

        const rows = await database.all<{ label: string }>(
          'SELECT label FROM contract_transactions',
        );
        expect(rows).toEqual([{ label: 'alpha' }]);
      });
    });

    it('rolls back failed transactions', async () => {
      await withDatabase(options, async (database) => {
        await database.exec(`
          CREATE TABLE contract_transaction_rollbacks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL
          );
        `);

        const didReject = await expectRejects(async () => {
          await database.transaction(async (tx) => {
            await tx.run('INSERT INTO contract_transaction_rollbacks (label) VALUES (?)', [
              'alpha',
            ]);
            throw new Error('rollback');
          });
        });

        const rows = await database.all<{ label: string }>(
          'SELECT label FROM contract_transaction_rollbacks',
        );
        expect(didReject).toBe(true);
        expect(rows).toHaveLength(0);
      });
    });

    it('rolls nested transactions into the parent transaction', async () => {
      await withDatabase(options, async (database) => {
        await database.exec(`
          CREATE TABLE contract_nested_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL
          );
        `);

        await database.transaction(async (outerTx) => {
          await outerTx.run('INSERT INTO contract_nested_transactions (label) VALUES (?)', [
            'outer',
          ]);
          await outerTx.transaction(async (innerTx) => {
            await innerTx.run('INSERT INTO contract_nested_transactions (label) VALUES (?)', [
              'inner',
            ]);
          });
        });

        const rows = await database.all<{ label: string }>(
          'SELECT label FROM contract_nested_transactions ORDER BY id ASC',
        );
        expect(rows).toEqual([{ label: 'outer' }, { label: 'inner' }]);
      });
    });

    it('serializes or isolates concurrent root transactions', async () => {
      await withDatabase(options, async (database) => {
        await database.exec(`
          CREATE TABLE contract_concurrent_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL
          );
        `);

        const firstEntered = createDeferred();
        const releaseFirst = createDeferred();

        const firstTransaction = database.transaction(async (tx) => {
          await tx.run('INSERT INTO contract_concurrent_transactions (label) VALUES (?)', [
            'first',
          ]);
          firstEntered.resolve();
          await releaseFirst.promise;
        });

        await firstEntered.promise;

        const secondTransaction = database.transaction(async (tx) => {
          await tx.run('INSERT INTO contract_concurrent_transactions (label) VALUES (?)', [
            'second',
          ]);
        });

        releaseFirst.resolve();
        await Promise.all([firstTransaction, secondTransaction]);

        const rows = await database.all<{ label: string }>(
          'SELECT label FROM contract_concurrent_transactions ORDER BY id ASC',
        );
        expect(rows).toEqual([{ label: 'first' }, { label: 'second' }]);
      });
    });
  });
}
