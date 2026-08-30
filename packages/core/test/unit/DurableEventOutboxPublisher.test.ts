import { describe, expect, it } from 'bun:test';
import {
  DurableEventConsumerError,
  DurableEventOutboxPublisher,
  DurableEventTransactionConflictError,
  prepareDurableEventRevisionBatch,
} from '../../outbox/index.ts';
import type {
  ClaimedDurableEvent,
  CompactDurableEventResult,
  DurableEventClaimMutationResult,
  DurableEventClaimOptions,
  DurableEventConsumerExecutor,
  DurableEventOutboxRepository,
  DurableEventStorageStats,
  EnqueueDurableEventResult,
  OutstandingDurableEventContract,
  RequeueBlockedDurableEventOptions,
  SafeDurableEventFailure,
} from '../../outbox/index.ts';
import type { Logger } from '../../logging/Logger.ts';

function claimedEvent(overrides: Partial<ClaimedDurableEvent> = {}): ClaimedDurableEvent {
  const intent = {
    id: 'event-1',
    envelopeVersion: 1 as const,
    eventKey: 'project-history',
    eventType: 'wallet.operation.finalized',
    consumerId: 'wallet.history.projector',
    streamId: 'operation-1',
    streamRevision: 1,
    payloadVersion: 1,
    payload: { operationId: 'operation-1' },
    occurredAt: 100,
  };
  const prepared = prepareDurableEventRevisionBatch(
    {
      streamId: intent.streamId,
      expectedPreviousRevision: 0,
      streamRevision: intent.streamRevision,
      events: [intent],
    },
    100,
  ).events[0]!;
  return {
    ...prepared,
    status: 'pending',
    createdAt: 100,
    availableAt: 100,
    claimCount: 1,
    failureCount: 0,
    totalFailureCount: 0,
    requeueCount: 0,
    lastAttemptAt: 100,
    leaseOwner: 'worker-1',
    leaseToken: 'token-1',
    leaseExpiresAt: 200,
    ...overrides,
  };
}

class PublisherRepository implements DurableEventOutboxRepository {
  readonly rescheduled: { failure: SafeDurableEventFailure; availableAt: number }[] = [];
  readonly blocked: SafeDurableEventFailure[] = [];
  private claimed = false;

  constructor(private readonly event: ClaimedDurableEvent) {}

  async claimNext(_options: DurableEventClaimOptions): Promise<ClaimedDurableEvent | null> {
    if (this.claimed) return null;
    this.claimed = true;
    return this.event;
  }

  async reschedule(
    _claim: { id: string; leaseToken: string },
    failure: SafeDurableEventFailure,
    availableAt: number,
  ): Promise<DurableEventClaimMutationResult> {
    this.rescheduled.push({ failure, availableAt });
    return 'updated';
  }

  async block(
    _claim: { id: string; leaseToken: string },
    failure: SafeDurableEventFailure,
  ): Promise<DurableEventClaimMutationResult> {
    this.blocked.push(failure);
    return 'updated';
  }

  async enqueueRevision(): Promise<EnqueueDurableEventResult> {
    throw new Error('not used');
  }

  async readAndValidateCurrentClaim(): Promise<ClaimedDurableEvent | null> {
    throw new Error('not used');
  }

  async markPublished(): Promise<DurableEventClaimMutationResult> {
    throw new Error('not used');
  }

  async compactPublishedThrough(): Promise<CompactDurableEventResult> {
    throw new Error('not used');
  }

  async requeueBlocked(_options: RequeueBlockedDurableEventOptions): Promise<number> {
    return 0;
  }

  async getStorageStats(): Promise<DurableEventStorageStats> {
    return {
      eventRows: 1,
      revisionSeals: 1,
      streams: 1,
      payloadBytes: this.event.payloadBytes,
      limits: {
        maxEventRows: 10,
        maxRevisionSeals: 10,
        maxStreams: 10,
        maxPayloadBytes: 1_000,
      },
    };
  }

  async listOutstandingContracts(): Promise<readonly OutstandingDurableEventContract[]> {
    return [];
  }
}

function publisher(
  repository: DurableEventOutboxRepository,
  consumer: DurableEventConsumerExecutor,
  logger?: Logger,
): DurableEventOutboxPublisher {
  return new DurableEventOutboxPublisher({
    repository,
    consumers: [consumer],
    workerId: 'worker-1',
    leaseDurationMs: 1_000,
    retryPolicy: { maxFailures: 3, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 },
    createLeaseToken: () => 'new-token',
    now: () => 200,
    jitter: () => 0.5,
    logger,
  });
}

function consumer(
  event: ClaimedDurableEvent,
  execute: DurableEventConsumerExecutor['execute'],
): DurableEventConsumerExecutor {
  return { contract: event, execute };
}

describe('DurableEventOutboxPublisher', () => {
  it('publishes one claimed event', async () => {
    const event = claimedEvent();
    const repository = new PublisherRepository(event);
    const worker = publisher(
      repository,
      consumer(event, async () => 'applied'),
    );

    await expect(worker.runOnce(10)).resolves.toEqual({
      claimed: 1,
      published: 1,
      rescheduled: 0,
      blocked: 0,
      stale: 0,
    });
  });

  it('logs only non-sensitive event metadata after publication', async () => {
    const event = claimedEvent({
      payload: { operationId: 'secret-operation-id', token: 'secret-token' },
    });
    const repository = new PublisherRepository(event);
    const entries: unknown[][] = [];
    const logger: Logger = {
      error() {},
      warn() {},
      info() {},
      debug(...entry) {
        entries.push(entry);
      },
    };
    const worker = publisher(
      repository,
      consumer(event, async () => 'applied'),
      logger,
    );

    await worker.runOnce(1);

    const serialized = JSON.stringify(entries);
    expect(serialized).toContain('event-1');
    expect(serialized).not.toContain('secret-operation-id');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('leaseToken');
    expect(serialized).not.toContain('payload');
  });

  it('reschedules an unknown consumer failure without storing its message', async () => {
    const event = claimedEvent();
    const repository = new PublisherRepository(event);
    const worker = publisher(
      repository,
      consumer(event, async () => {
        throw new Error('payload and secret data');
      }),
    );

    const result = await worker.runOnce(1);

    expect(result.rescheduled).toBe(1);
    expect(repository.rescheduled).toEqual([
      { failure: { code: 'outbox.consumer_failed' }, availableAt: 300 },
    ]);
  });

  it('blocks a deterministic consumer failure', async () => {
    const event = claimedEvent();
    const repository = new PublisherRepository(event);
    const worker = publisher(
      repository,
      consumer(event, async () => {
        throw new DurableEventConsumerError({
          code: 'history.invalid_operation',
          retryable: false,
          safeMessage: 'Operation data is invalid',
        });
      }),
    );

    const result = await worker.runOnce(1);

    expect(result.blocked).toBe(1);
    expect(repository.blocked).toEqual([
      { code: 'history.invalid_operation', message: 'Operation data is invalid' },
    ]);
  });

  it('blocks a retryable failure at the failure limit', async () => {
    const event = claimedEvent({ failureCount: 2 });
    const repository = new PublisherRepository(event);
    const worker = publisher(
      repository,
      consumer(event, async () => {
        throw new Error('temporary failure');
      }),
    );

    const result = await worker.runOnce(1);

    expect(result.blocked).toBe(1);
    expect(repository.blocked).toEqual([{ code: 'outbox.consumer_failed' }]);
  });

  it('does not count a transaction conflict as a delivery failure', async () => {
    const event = claimedEvent();
    const repository = new PublisherRepository(event);
    const worker = publisher(
      repository,
      consumer(event, async () => {
        throw new DurableEventTransactionConflictError();
      }),
    );

    await expect(worker.runOnce(1)).rejects.toBeInstanceOf(DurableEventTransactionConflictError);
    expect(repository.rescheduled).toEqual([]);
    expect(repository.blocked).toEqual([]);
  });
});
