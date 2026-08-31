import { describe, expect, it } from 'bun:test';
import {
  DurableEventConsumerError,
  DurableEventTransactionConflictError,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase } from '../index.ts';
import { runSqliteDurableEventOutboxTransaction } from '../DurableEventOutboxTransactionPort.ts';

describe('SQLite durable event outbox transaction port', () => {
  it('maps exhausted busy retries to a transaction conflict', async () => {
    let attempts = 0;
    const database = {
      async transaction() {
        attempts += 1;
        const error = new Error('database is locked') as Error & { code: string };
        error.code = 'SQLITE_BUSY';
        throw error;
      },
    } as unknown as SqlDatabase;

    await expect(
      runSqliteDurableEventOutboxTransaction(database, async () => undefined),
    ).rejects.toBeInstanceOf(DurableEventTransactionConflictError);
    expect(attempts).toBe(51);
  });

  it('does not retry consumer errors whose messages resemble SQLite lock errors', async () => {
    let attempts = 0;
    const database = {
      async transaction(work: (transaction: SqlDatabase) => Promise<unknown>) {
        return work(database as unknown as SqlDatabase);
      },
    } as unknown as SqlDatabase;
    const consumerError = new DurableEventConsumerError({
      code: 'consumer.database_locked',
      retryable: false,
      safeMessage: 'database is locked',
    }) as DurableEventConsumerError & { errno: number };
    consumerError.errno = 5;

    await expect(
      runSqliteDurableEventOutboxTransaction(database, async () => {
        attempts += 1;
        throw consumerError;
      }),
    ).rejects.toBe(consumerError);
    expect(attempts).toBe(1);
  });
});
