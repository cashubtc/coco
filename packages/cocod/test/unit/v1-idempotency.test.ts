import { expect, test } from 'bun:test';

import { IdempotencyCapacityError, ProcessLocalIdempotency } from '../../src/v1/idempotency.js';
import { deferred } from '../helpers/deferred.js';

test('removes failed idempotency commands so the same key can retry', async () => {
  const idempotency = new ProcessLocalIdempotency();
  let attempts = 0;
  const operation = () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('temporary failure');
    }
    return 'accepted';
  };

  await expect(idempotency.execute('retry-key', { action: 'start' }, operation)).rejects.toThrow(
    'temporary failure',
  );
  await expect(idempotency.execute('retry-key', { action: 'start' }, operation)).resolves.toBe(
    'accepted',
  );
  expect(attempts).toBe(2);
});

test('keeps pending commands bounded without evicting their replay records', async () => {
  const idempotency = new ProcessLocalIdempotency(1);
  const completion = deferred<string>();
  const first = idempotency.execute('first', { action: 'start' }, () => completion.promise);

  await expect(
    idempotency.execute('second', { action: 'stop' }, () => 'second result'),
  ).rejects.toBeInstanceOf(IdempotencyCapacityError);

  completion.resolve('first result');
  await expect(first).resolves.toBe('first result');
  await expect(
    idempotency.execute('second', { action: 'stop' }, () => 'second result'),
  ).resolves.toBe('second result');
});
