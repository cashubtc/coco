import type {
  DurableEventOutboxRepository,
  DurableEventOutboxTransactionPort,
} from '@cashu/coco-core/adapter';
import { DurableEventTransactionConflictError } from '@cashu/coco-core/adapter';
import type { SqlDatabase } from './index.ts';
import { SqliteDurableEventOutboxRepository } from './repositories/DurableEventOutboxRepository.ts';

const MAX_BUSY_RETRIES = 50;

function sqliteErrorCode(error: Error): string {
  return 'code' in error ? String(error.code).toUpperCase() : '';
}

function sqliteErrorNumber(error: Error): number | undefined {
  if (!('errno' in error)) return undefined;
  const errno = Number(error.errno);
  return Number.isInteger(errno) ? errno : undefined;
}

function isBusyConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = sqliteErrorCode(error);
  const errno = sqliteErrorNumber(error);
  const isSqliteDriverError =
    error.name.toUpperCase() === 'SQLITEERROR' || code.startsWith('SQLITE_');
  if (!isSqliteDriverError) return false;
  if (/^SQLITE_(BUSY|LOCKED)(?:_|$)/.test(code)) return true;
  if (errno !== undefined && (errno & 0xff) === 5) return true;
  if (errno !== undefined && (errno & 0xff) === 6) return true;

  const message = error.message.toUpperCase();
  return (
    message.includes('SQLITE_BUSY') ||
    message.includes('SQLITE_LOCKED') ||
    message.includes('DATABASE IS LOCKED')
  );
}

/**
 * Run a writer-serialized SQL outbox transaction.
 *
 * SQLite busy/locked errors are confirmed-uncommitted conflicts and may repeat `work`. Callers must
 * create IDs, timestamps, and random inputs before entering the callback and must not perform
 * external effects inside it.
 */
export async function runSqliteDurableEventOutboxTransaction<T>(
  database: SqlDatabase,
  work: (database: SqlDatabase, outbox: DurableEventOutboxRepository) => Promise<T>,
): Promise<T> {
  const attempt = async (remainingAttempts: number): Promise<T> => {
    try {
      return await database.transaction(
        (transaction) => work(transaction, new SqliteDurableEventOutboxRepository(transaction)),
        { mode: 'immediate' },
      );
    } catch (error) {
      if (!isBusyConflict(error)) throw error;
      if (remainingAttempts === 0) {
        throw new DurableEventTransactionConflictError(
          'SQLite durable event transaction remained busy after bounded retries',
        );
      }
      await Promise.resolve();
      return attempt(remainingAttempts - 1);
    }
  };

  return attempt(MAX_BUSY_RETRIES);
}

/** Public root transaction capability used by publishers and outbox administration. */
export class SqliteDurableEventOutboxTransactionPort implements DurableEventOutboxTransactionPort {
  constructor(private readonly database: SqlDatabase) {}

  run<T>(work: (outbox: DurableEventOutboxRepository) => Promise<T>): Promise<T> {
    return runSqliteDurableEventOutboxTransaction(this.database, (_database, outbox) =>
      work(outbox),
    );
  }
}
