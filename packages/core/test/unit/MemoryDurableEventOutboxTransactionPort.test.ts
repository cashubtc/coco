import { describe, expect, it } from 'bun:test';
import { MemoryDurableEventOutboxTransactionPort } from '../../outbox/index.ts';
import type { DurableEventRevisionBatch } from '../../outbox/index.ts';

function batch(id: string, revision: number): DurableEventRevisionBatch {
  return {
    streamId: 'operation-1',
    expectedPreviousRevision: revision - 1,
    streamRevision: revision,
    events: [
      {
        id,
        envelopeVersion: 1,
        eventKey: 'project-history',
        eventType: 'wallet.operation.finalized',
        consumerId: 'wallet.history.projector',
        streamId: 'operation-1',
        streamRevision: revision,
        payloadVersion: 1,
        payload: { operationId: 'operation-1', revision },
        occurredAt: 100 + revision,
      },
    ],
  };
}

describe('MemoryDurableEventOutboxTransactionPort', () => {
  it('commits a successful root transaction', async () => {
    const transactions = new MemoryDurableEventOutboxTransactionPort();

    await transactions.run((outbox) => outbox.enqueueRevision(batch('event-1', 1), 101));

    await expect(transactions.run((outbox) => outbox.getStorageStats())).resolves.toMatchObject({
      eventRows: 1,
      revisionSeals: 1,
    });
  });

  it('rolls back a failed root transaction', async () => {
    const transactions = new MemoryDurableEventOutboxTransactionPort();

    await expect(
      transactions.run(async (outbox) => {
        await outbox.enqueueRevision(batch('event-1', 1), 101);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    await expect(transactions.run((outbox) => outbox.getStorageStats())).resolves.toMatchObject({
      eventRows: 0,
      revisionSeals: 0,
    });
  });

  it('serializes concurrent root transactions', async () => {
    const transactions = new MemoryDurableEventOutboxTransactionPort();

    await Promise.all([
      transactions.run((outbox) => outbox.enqueueRevision(batch('event-1', 1), 101)),
      transactions.run((outbox) => outbox.enqueueRevision(batch('event-2', 2), 102)),
    ]);

    await expect(transactions.run((outbox) => outbox.getStorageStats())).resolves.toMatchObject({
      eventRows: 2,
      revisionSeals: 2,
    });
  });
});
