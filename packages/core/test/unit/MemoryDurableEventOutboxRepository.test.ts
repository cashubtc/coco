import { describe, expect, it } from 'bun:test';
import {
  DurableEventBatchConflictError,
  DurableEventCapacityExceededError,
  DurableEventRevisionAlreadyCompactedError,
  MemoryDurableEventOutboxRepository,
} from '../../outbox/index.ts';
import type {
  DurableEventContract,
  DurableEventIntent,
  DurableEventRevisionBatch,
} from '../../outbox/index.ts';

const contract: DurableEventContract = {
  consumerId: 'wallet.history.projector',
  eventType: 'wallet.operation.finalized',
  envelopeVersion: 1,
  payloadVersion: 1,
};

function batch(
  options: {
    revision?: number;
    previousRevision?: number | null;
    id?: string;
    eventKey?: string;
    payload?: DurableEventIntent['payload'];
  } = {},
): DurableEventRevisionBatch {
  const revision = options.revision ?? 1;
  const intent: DurableEventIntent = {
    ...contract,
    id: options.id ?? `event-${revision}`,
    eventKey: options.eventKey ?? 'project-history',
    streamId: 'operation-1',
    streamRevision: revision,
    payload: options.payload ?? { operationId: 'operation-1', revision },
    occurredAt: 100 + revision,
  };
  return {
    streamId: intent.streamId,
    expectedPreviousRevision: options.previousRevision ?? revision - 1,
    streamRevision: revision,
    events: [intent],
  };
}

describe('MemoryDurableEventOutboxRepository', () => {
  it('stores a sealed batch and accepts only an identical semantic retry', async () => {
    const repository = new MemoryDurableEventOutboxRepository();

    await expect(repository.enqueueRevision(batch(), 100)).resolves.toEqual({
      outcome: 'inserted',
      eventIds: ['event-1'],
    });
    await expect(repository.enqueueRevision(batch({ id: 'retry-id' }), 200)).resolves.toEqual({
      outcome: 'existing',
      eventIds: ['event-1'],
    });
    await expect(
      repository.enqueueRevision(batch({ id: 'other-id', payload: { changed: true } }), 200),
    ).rejects.toBeInstanceOf(DurableEventBatchConflictError);
  });

  it('checks capacity before it changes outbox state', async () => {
    const repository = new MemoryDurableEventOutboxRepository({
      limits: {
        maxEventRows: 1,
        maxRevisionSeals: 2,
        maxStreams: 1,
        maxPayloadBytes: 1_000,
      },
    });
    await repository.enqueueRevision(batch(), 100);

    await expect(
      repository.enqueueRevision(batch({ revision: 2, previousRevision: 1 }), 101),
    ).rejects.toBeInstanceOf(DurableEventCapacityExceededError);
    await expect(repository.getStorageStats()).resolves.toMatchObject({
      eventRows: 1,
      revisionSeals: 1,
      streams: 1,
    });
  });

  it('claims only supported work and fences an expired lease token', async () => {
    const repository = new MemoryDurableEventOutboxRepository();
    await repository.enqueueRevision(batch(), 100);

    await expect(
      repository.claimNext({
        workerId: 'worker-1',
        leaseToken: 'token-1',
        leaseDurationMs: 10,
        now: 100,
        contracts: [{ ...contract, payloadVersion: 2 }],
      }),
    ).resolves.toBeNull();

    const first = await repository.claimNext({
      workerId: 'worker-1',
      leaseToken: 'token-1',
      leaseDurationMs: 10,
      now: 100,
      contracts: [contract],
    });
    expect(first?.leaseToken).toBe('token-1');

    const second = await repository.claimNext({
      workerId: 'worker-2',
      leaseToken: 'token-2',
      leaseDurationMs: 10,
      now: 110,
      contracts: [contract],
    });
    expect(second?.leaseToken).toBe('token-2');
    await expect(repository.markPublished('event-1', 'token-1', 111)).resolves.toBe('stale');
    await expect(repository.markPublished('event-1', 'token-2', 111)).resolves.toBe('updated');
  });

  it('keeps failure history when blocked work is requeued', async () => {
    const repository = new MemoryDurableEventOutboxRepository();
    await repository.enqueueRevision(batch(), 100);
    await repository.claimNext({
      workerId: 'worker-1',
      leaseToken: 'token-1',
      leaseDurationMs: 10,
      now: 100,
      contracts: [contract],
    });
    await repository.reschedule(
      { id: 'event-1', leaseToken: 'token-1' },
      { code: 'outbox.consumer_failed' },
      120,
    );
    const second = await repository.claimNext({
      workerId: 'worker-1',
      leaseToken: 'token-2',
      leaseDurationMs: 10,
      now: 120,
      contracts: [contract],
    });
    expect(second?.failureCount).toBe(1);
    await repository.block(
      { id: 'event-1', leaseToken: 'token-2' },
      { code: 'history.invalid_operation', message: 'Operation data is invalid' },
      121,
    );

    await expect(repository.listOutstandingContracts()).resolves.toEqual([
      { ...contract, status: 'blocked', count: 1, oldestCreatedAt: 100 },
    ]);
    await expect(repository.requeueBlocked({ contract, limit: 1, now: 130 })).resolves.toBe(1);
    const third = await repository.claimNext({
      workerId: 'worker-1',
      leaseToken: 'token-3',
      leaseDurationMs: 10,
      now: 130,
      contracts: [contract],
    });
    expect(third).toMatchObject({ failureCount: 0, totalFailureCount: 2, requeueCount: 1 });
  });

  it('compacts published rows and keeps the stream revision checkpoint', async () => {
    const repository = new MemoryDurableEventOutboxRepository();
    await repository.enqueueRevision(batch(), 100);
    await repository.claimNext({
      workerId: 'worker-1',
      leaseToken: 'token-1',
      leaseDurationMs: 10,
      now: 100,
      contracts: [contract],
    });
    await repository.markPublished('event-1', 'token-1', 110);

    await expect(
      repository.compactPublishedThrough({
        streamId: 'operation-1',
        throughRevision: 1,
        retentionCutoff: 120,
        now: 130,
      }),
    ).resolves.toEqual({
      compactedThroughRevision: 1,
      deletedEventRows: 1,
      deletedRevisionSeals: 1,
    });
    await expect(repository.getStorageStats()).resolves.toMatchObject({
      eventRows: 0,
      revisionSeals: 0,
      streams: 1,
      payloadBytes: 0,
    });
    await expect(repository.enqueueRevision(batch({ id: 'retry-id' }), 140)).rejects.toBeInstanceOf(
      DurableEventRevisionAlreadyCompactedError,
    );
    await expect(
      repository.enqueueRevision(batch({ revision: 2, previousRevision: 0 }), 140),
    ).rejects.toBeInstanceOf(DurableEventBatchConflictError);
    await expect(
      repository.enqueueRevision(batch({ revision: 2, previousRevision: 1 }), 140),
    ).resolves.toMatchObject({ outcome: 'inserted' });
  });

  it('provides explicit state copies for host-owned transaction staging', async () => {
    const committed = new MemoryDurableEventOutboxRepository();
    await committed.enqueueRevision(batch(), 100);
    const staged = committed.clone();
    await staged.enqueueRevision(batch({ revision: 2, previousRevision: 1 }), 101);

    await expect(committed.getStorageStats()).resolves.toMatchObject({ eventRows: 1 });
    committed.replaceWith(staged);
    await expect(committed.getStorageStats()).resolves.toMatchObject({ eventRows: 2 });
  });

  it('rejects a stale host transaction snapshot', async () => {
    const committed = new MemoryDurableEventOutboxRepository();
    await committed.enqueueRevision(batch(), 100);
    const first = committed.clone();
    const second = committed.clone();
    await first.enqueueRevision(batch({ revision: 2, previousRevision: 1 }), 101);
    await second.enqueueRevision(batch({ revision: 2, previousRevision: 1 }), 101);

    committed.replaceWith(first);
    expect(() => committed.replaceWith(second)).toThrow('state changed after the host transaction');
  });
});
