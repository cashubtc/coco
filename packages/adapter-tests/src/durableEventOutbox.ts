import type {
  ClaimedDurableEvent,
  DurableEventContract,
  DurableEventIntent,
  DurableEventOutboxRepository,
  DurableEventRevisionBatch,
  DurableEventStorageLimits,
} from '@cashu/coco-core/adapter';
import type { ContractRunner } from './index.ts';

export interface DurableEventOutboxRepositoryHandle {
  readonly repository: DurableEventOutboxRepository;
  dispose(): Promise<void>;
}

export interface SharedDurableEventOutboxRepositoryHandle {
  readonly first: DurableEventOutboxRepository;
  readonly second: DurableEventOutboxRepository;
  dispose(): Promise<void>;
}

export interface RestartableDurableEventOutboxRepositoryHandle {
  readonly repository: DurableEventOutboxRepository;
  restart(): Promise<DurableEventOutboxRepository>;
  dispose(): Promise<void>;
}

export interface DurableEventOutboxRepositoryContractOptions {
  createRepository(options?: {
    readonly limits?: DurableEventStorageLimits;
  }): Promise<DurableEventOutboxRepositoryHandle>;
  createSharedRepositories?(): Promise<SharedDurableEventOutboxRepositoryHandle>;
  createRestartableRepository?(): Promise<RestartableDurableEventOutboxRepositoryHandle>;
}

const contract: DurableEventContract = {
  consumerId: 'wallet.history.projector',
  eventType: 'wallet.operation.finalized',
  envelopeVersion: 1,
  payloadVersion: 1,
};

function eventBatch(
  options: {
    streamId?: string;
    revision?: number;
    previousRevision?: number | null;
    id?: string;
    eventKey?: string;
    occurredAt?: number;
    payload?: DurableEventIntent['payload'];
  } = {},
): DurableEventRevisionBatch {
  const streamId = options.streamId ?? 'operation-1';
  const revision = options.revision ?? 1;
  return {
    streamId,
    expectedPreviousRevision: options.previousRevision ?? revision - 1,
    streamRevision: revision,
    events: [
      {
        ...contract,
        id: options.id ?? `${streamId}-event-${revision}`,
        eventKey: options.eventKey ?? 'project-history',
        streamId,
        streamRevision: revision,
        payload: options.payload ?? { operationId: streamId, revision },
        occurredAt: options.occurredAt ?? 100 + revision,
      },
    ],
  };
}

function claimOptions(options: {
  token: string;
  now: number;
  contracts?: readonly DurableEventContract[];
  workerId?: string;
  leaseDurationMs?: number;
}) {
  return {
    workerId: options.workerId ?? 'worker-1',
    leaseToken: options.token,
    leaseDurationMs: options.leaseDurationMs ?? 10,
    now: options.now,
    contracts: options.contracts ?? [contract],
  };
}

async function expectErrorName(
  work: () => Promise<unknown>,
  name: string,
  expect: ContractRunner['expect'],
): Promise<void> {
  let error: unknown;
  try {
    await work();
  } catch (cause) {
    error = cause;
  }
  expect(error instanceof Error ? error.name : undefined).toBe(name);
}

async function claimOne(
  repository: DurableEventOutboxRepository,
  token: string,
  now: number,
): Promise<ClaimedDurableEvent> {
  const event = await repository.claimNext(claimOptions({ token, now }));
  if (!event) throw new Error('Expected the adapter to claim one durable event');
  return event;
}

/**
 * Runs the storage behavior contract for a durable event outbox repository.
 *
 * The factory supplies repositories that are ready for use. This contract does not prescribe how
 * a host creates transactions or binds a repository to an active transaction.
 */
export function runDurableEventOutboxRepositoryContract(
  options: DurableEventOutboxRepositoryContractOptions,
  runner: ContractRunner,
): void {
  const { describe, it, expect } = runner;

  describe('durable event outbox repository contract', () => {
    it('stores one sealed batch and accepts an identical semantic retry', async () => {
      const { repository, dispose } = await options.createRepository();
      try {
        const inserted = await repository.enqueueRevision(eventBatch(), 100);
        const existing = await repository.enqueueRevision(eventBatch({ id: 'retry-id' }), 200);

        expect(inserted.outcome).toBe('inserted');
        expect(inserted.eventIds.join(',')).toBe('operation-1-event-1');
        expect(existing.outcome).toBe('existing');
        expect(existing.eventIds.join(',')).toBe('operation-1-event-1');
        await expectErrorName(
          () =>
            repository.enqueueRevision(
              eventBatch({ id: 'other-id', payload: { changed: true } }),
              200,
            ),
          'DurableEventBatchConflictError',
          expect,
        );
      } finally {
        await dispose();
      }
    });

    it('rejects capacity overflow before it changes storage', async () => {
      const { repository, dispose } = await options.createRepository({
        limits: {
          maxEventRows: 1,
          maxRevisionSeals: 2,
          maxStreams: 2,
          maxPayloadBytes: 1_000,
        },
      });
      try {
        await repository.enqueueRevision(eventBatch(), 100);
        await expectErrorName(
          () =>
            repository.enqueueRevision(
              eventBatch({ streamId: 'operation-2', id: 'operation-2-event-1' }),
              101,
            ),
          'DurableEventCapacityExceededError',
          expect,
        );
        const stats = await repository.getStorageStats();
        expect(stats.eventRows).toBe(1);
        expect(stats.revisionSeals).toBe(1);
        expect(stats.streams).toBe(1);
      } finally {
        await dispose();
      }
    });

    it('claims only supported contracts in deterministic preference order', async () => {
      const { repository, dispose } = await options.createRepository();
      try {
        await repository.enqueueRevision(
          eventBatch({ streamId: 'later', id: 'later-event', occurredAt: 200 }),
          100,
        );
        await repository.enqueueRevision(
          eventBatch({ streamId: 'earlier', id: 'earlier-event', occurredAt: 50 }),
          100,
        );
        const unsupported = await repository.claimNext(
          claimOptions({
            token: 'unsupported-token',
            now: 100,
            contracts: [{ ...contract, payloadVersion: 2 }],
          }),
        );
        expect(unsupported).toBe(null);

        const claimed = await claimOne(repository, 'supported-token', 100);
        expect(claimed.id).toBe('earlier-event');
        expect(claimed.claimCount).toBe(1);
        expect(claimed.leaseToken).toBe('supported-token');
      } finally {
        await dispose();
      }
    });

    it('allows only one concurrent claim for one available event', async () => {
      const { repository, dispose } = await options.createRepository();
      try {
        await repository.enqueueRevision(eventBatch(), 100);
        const claims = await Promise.all([
          repository.claimNext(claimOptions({ token: 'token-1', now: 100, workerId: 'worker-1' })),
          repository.claimNext(claimOptions({ token: 'token-2', now: 100, workerId: 'worker-2' })),
        ]);
        expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      } finally {
        await dispose();
      }
    });

    it('fences an expired lease token after another worker claims the event', async () => {
      const { repository, dispose } = await options.createRepository();
      try {
        await repository.enqueueRevision(eventBatch(), 100);
        await claimOne(repository, 'old-token', 100);
        const replacement = await repository.claimNext(
          claimOptions({ token: 'new-token', now: 110, workerId: 'worker-2' }),
        );
        expect(replacement?.leaseToken).toBe('new-token');
        expect(
          await repository.reschedule(
            { id: 'operation-1-event-1', leaseToken: 'old-token' },
            { code: 'outbox.consumer_failed' },
            120,
          ),
        ).toBe('stale');
        expect(
          await repository.block(
            { id: 'operation-1-event-1', leaseToken: 'old-token' },
            { code: 'outbox.consumer_failed' },
            111,
          ),
        ).toBe('stale');
        expect(await repository.markPublished('operation-1-event-1', 'old-token', 111)).toBe(
          'stale',
        );
        expect(await repository.markPublished('operation-1-event-1', 'new-token', 111)).toBe(
          'updated',
        );
      } finally {
        await dispose();
      }
    });

    it('persists retry, blocked, and requeue history without payload inspection', async () => {
      const { repository, dispose } = await options.createRepository();
      try {
        await repository.enqueueRevision(eventBatch(), 100);
        await claimOne(repository, 'token-1', 100);
        expect(
          await repository.reschedule(
            { id: 'operation-1-event-1', leaseToken: 'token-1' },
            { code: 'outbox.consumer_failed' },
            120,
          ),
        ).toBe('updated');
        expect(await repository.claimNext(claimOptions({ token: 'too-early', now: 119 }))).toBe(
          null,
        );

        const retried = await claimOne(repository, 'token-2', 120);
        expect(retried.failureCount).toBe(1);
        expect(
          await repository.block(
            { id: retried.id, leaseToken: retried.leaseToken },
            { code: 'history.invalid_operation', message: 'Operation data is invalid' },
            121,
          ),
        ).toBe('updated');

        const outstanding = await repository.listOutstandingContracts();
        expect(outstanding).toHaveLength(1);
        expect(outstanding[0]?.status).toBe('blocked');
        expect(outstanding[0]?.count).toBe(1);
        const inspectionJson = JSON.stringify(outstanding);
        expect(inspectionJson.includes('"payload":')).toBe(false);
        expect(inspectionJson.includes('operationId')).toBe(false);

        expect(await repository.requeueBlocked({ contract, limit: 1, now: 130 })).toBe(1);
        const requeued = await claimOne(repository, 'token-3', 130);
        expect(requeued.failureCount).toBe(0);
        expect(requeued.totalFailureCount).toBe(2);
        expect(requeued.requeueCount).toBe(1);
      } finally {
        await dispose();
      }
    });

    it('compacts only retained published work and preserves revision deduplication', async () => {
      const { repository, dispose } = await options.createRepository();
      try {
        await repository.enqueueRevision(eventBatch(), 100);
        await expectErrorName(
          () =>
            repository.compactPublishedThrough({
              streamId: 'operation-1',
              throughRevision: 1,
              retentionCutoff: 100,
              now: 100,
            }),
          'DurableEventInvariantError',
          expect,
        );
        const claimed = await claimOne(repository, 'token-1', 100);
        expect(await repository.markPublished(claimed.id, claimed.leaseToken, 110)).toBe('updated');

        await expectErrorName(
          () =>
            repository.compactPublishedThrough({
              streamId: 'operation-1',
              throughRevision: 1,
              retentionCutoff: 109,
              now: 120,
            }),
          'DurableEventInvariantError',
          expect,
        );
        const compacted = await repository.compactPublishedThrough({
          streamId: 'operation-1',
          throughRevision: 1,
          retentionCutoff: 110,
          now: 120,
        });
        expect(compacted.deletedEventRows).toBe(1);
        expect(compacted.deletedRevisionSeals).toBe(1);
        const stats = await repository.getStorageStats();
        expect(stats.eventRows).toBe(0);
        expect(stats.revisionSeals).toBe(0);
        expect(stats.streams).toBe(1);
        await expectErrorName(
          () => repository.enqueueRevision(eventBatch({ id: 'old-retry' }), 130),
          'DurableEventRevisionAlreadyCompactedError',
          expect,
        );

        await repository.enqueueRevision(
          eventBatch({ streamId: 'blocked-operation', id: 'blocked-event' }),
          130,
        );
        const blocked = await claimOne(repository, 'blocked-token', 130);
        expect(
          await repository.block(
            { id: blocked.id, leaseToken: blocked.leaseToken },
            { code: 'outbox.consumer_failed' },
            131,
          ),
        ).toBe('updated');
        await expectErrorName(
          () =>
            repository.compactPublishedThrough({
              streamId: 'blocked-operation',
              throughRevision: 1,
              retentionCutoff: 200,
              now: 200,
            }),
          'DurableEventInvariantError',
          expect,
        );
      } finally {
        await dispose();
      }
    });

    const createRestartableRepository = options.createRestartableRepository;
    if (createRestartableRepository) {
      it('preserves delivery history, publication, and compaction checkpoints across restart', async () => {
        const handle = await createRestartableRepository();
        try {
          let repository = handle.repository;
          await repository.enqueueRevision(eventBatch(), 100);
          const retryClaim = await claimOne(repository, 'retry-token', 100);
          expect(
            await repository.reschedule(
              { id: retryClaim.id, leaseToken: retryClaim.leaseToken },
              { code: 'outbox.consumer_failed' },
              120,
            ),
          ).toBe('updated');
          await repository.enqueueRevision(
            eventBatch({ streamId: 'published-operation', id: 'published-event' }),
            100,
          );
          const publishedClaim = await claimOne(repository, 'published-token', 100);
          expect(
            await repository.markPublished(publishedClaim.id, publishedClaim.leaseToken, 110),
          ).toBe('updated');

          repository = await handle.restart();
          expect(await repository.claimNext(claimOptions({ token: 'too-early', now: 119 }))).toBe(
            null,
          );
          const afterRestart = await claimOne(repository, 'blocked-token', 120);
          expect(afterRestart.failureCount).toBe(1);
          expect(afterRestart.totalFailureCount).toBe(1);
          expect(
            await repository.block(
              { id: afterRestart.id, leaseToken: afterRestart.leaseToken },
              { code: 'history.invalid_operation' },
              121,
            ),
          ).toBe('updated');

          repository = await handle.restart();
          const outstanding = await repository.listOutstandingContracts();
          expect(outstanding).toHaveLength(1);
          expect(outstanding[0]?.status).toBe('blocked');
          expect(outstanding[0]?.count).toBe(1);
          const compacted = await repository.compactPublishedThrough({
            streamId: 'published-operation',
            throughRevision: 1,
            retentionCutoff: 110,
            now: 130,
          });
          expect(compacted.deletedEventRows).toBe(1);
          expect(compacted.deletedRevisionSeals).toBe(1);

          repository = await handle.restart();
          await expectErrorName(
            () =>
              repository.enqueueRevision(
                eventBatch({ streamId: 'published-operation', id: 'compacted-retry' }),
                140,
              ),
            'DurableEventRevisionAlreadyCompactedError',
            expect,
          );
          expect(await repository.requeueBlocked({ contract, limit: 1, now: 140 })).toBe(1);
          const requeued = await claimOne(repository, 'requeued-token', 140);
          expect(requeued.failureCount).toBe(0);
          expect(requeued.totalFailureCount).toBe(2);
          expect(requeued.requeueCount).toBe(1);
        } finally {
          await handle.dispose();
        }
      });
    }

    const createSharedRepositories = options.createSharedRepositories;
    if (createSharedRepositories) {
      it('coordinates claims across repository roots that share one store', async () => {
        const { first, second, dispose } = await createSharedRepositories();
        try {
          await first.enqueueRevision(eventBatch(), 100);
          const claims = await Promise.all([
            first.claimNext(claimOptions({ token: 'root-1-token', now: 100, workerId: 'root-1' })),
            second.claimNext(claimOptions({ token: 'root-2-token', now: 100, workerId: 'root-2' })),
          ]);
          expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
          expect((await second.getStorageStats()).eventRows).toBe(1);
        } finally {
          await dispose();
        }
      });

      it('serializes enqueue and compaction without losing the next revision', async () => {
        const { first, second, dispose } = await createSharedRepositories();
        try {
          await first.enqueueRevision(eventBatch(), 100);
          const claimed = await claimOne(first, 'published-token', 100);
          expect(await first.markPublished(claimed.id, claimed.leaseToken, 110)).toBe('updated');
          const [, nextRevision] = await Promise.all([
            first.compactPublishedThrough({
              streamId: 'operation-1',
              throughRevision: 1,
              retentionCutoff: 110,
              now: 120,
            }),
            second.enqueueRevision(
              eventBatch({ revision: 2, previousRevision: 1, id: 'operation-1-event-2' }),
              120,
            ),
          ]);
          expect(nextRevision.outcome).toBe('inserted');
          const stats = await first.getStorageStats();
          expect(stats.eventRows).toBe(1);
          expect(stats.revisionSeals).toBe(1);
          expect(stats.streams).toBe(1);
          const nextClaim = await claimOne(second, 'next-token', 120);
          expect(nextClaim.streamRevision).toBe(2);
        } finally {
          await dispose();
        }
      });

      it('serializes simultaneous claim, publication, enqueue, and compaction attempts', async () => {
        const { first, second, dispose } = await createSharedRepositories();
        try {
          await first.enqueueRevision(eventBatch(), 100);
          const compactedClaim = await claimOne(first, 'compact-token', 100);
          expect(await first.markPublished(compactedClaim.id, compactedClaim.leaseToken, 110)).toBe(
            'updated',
          );

          await first.enqueueRevision(
            eventBatch({ streamId: 'claim-stream', id: 'claim-event' }),
            100,
          );
          await first.enqueueRevision(
            eventBatch({ streamId: 'publish-stream', id: 'publish-event' }),
            100,
          );
          const publicationClaim = await claimOne(first, 'publication-token', 100);
          expect(publicationClaim.id).toBe('claim-event');
          const nextPublicationClaim = await claimOne(first, 'publication-token-2', 100);
          expect(nextPublicationClaim.id).toBe('publish-event');

          const [compaction, enqueue, claim, publication] = await Promise.all([
            first.compactPublishedThrough({
              streamId: 'operation-1',
              throughRevision: 1,
              retentionCutoff: 110,
              now: 120,
            }),
            second.enqueueRevision(
              eventBatch({ revision: 2, previousRevision: 1, id: 'operation-1-event-2' }),
              120,
            ),
            second.claimNext(
              claimOptions({ token: 'replacement-claim-token', now: 110, workerId: 'root-2' }),
            ),
            second.markPublished(nextPublicationClaim.id, nextPublicationClaim.leaseToken, 120),
          ]);

          expect(compaction.deletedEventRows).toBe(1);
          expect(enqueue.outcome).toBe('inserted');
          expect(claim?.id).toBe('claim-event');
          expect(publication).toBe('updated');
          const stats = await first.getStorageStats();
          expect(stats.eventRows).toBe(3);
          expect(stats.revisionSeals).toBe(3);
          expect(stats.streams).toBe(3);
        } finally {
          await dispose();
        }
      });
    }
  });
}
