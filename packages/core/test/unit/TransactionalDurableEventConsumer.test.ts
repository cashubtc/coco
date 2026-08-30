import { describe, expect, it } from 'bun:test';
import {
  DurableEventCorruptRecordError,
  DurableEventStaleClaimError,
  createDurableEventConsumerExecutor,
  prepareDurableEventRevisionBatch,
} from '../../outbox/index.ts';
import type {
  ClaimedDurableEvent,
  DurableEventConsumerTransactionPort,
  DurableEventOutboxConsumerWriter,
} from '../../outbox/index.ts';

function claimedEvent(): ClaimedDurableEvent {
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
  };
}

interface EffectScope {
  values: string[];
}

function transactionHarness(event: ClaimedDurableEvent | null) {
  let current = event;
  let published = false;
  const values: string[] = [];
  const writer: DurableEventOutboxConsumerWriter = {
    async readAndValidateCurrentClaim(claim) {
      if (!current || current.id !== claim.id || current.leaseToken !== claim.leaseToken)
        return null;
      return current;
    },
    async markPublished(id, leaseToken) {
      if (!current || current.id !== id || current.leaseToken !== leaseToken) return 'stale';
      published = true;
      current = null;
      return 'updated';
    },
  };
  const port: DurableEventConsumerTransactionPort<EffectScope> = {
    async run(work) {
      const valueSnapshot = [...values];
      const eventSnapshot = current;
      const publishedSnapshot = published;
      try {
        return await work({ effect: { values }, outbox: writer });
      } catch (error) {
        values.splice(0, values.length, ...valueSnapshot);
        current = eventSnapshot;
        published = publishedSnapshot;
        throw error;
      }
    },
  };
  return {
    port,
    values,
    isPublished: () => published,
    replaceEvent: (next: ClaimedDurableEvent) => (current = next),
  };
}

describe('transactional durable event consumer', () => {
  it('commits the local effect and publication together', async () => {
    const event = claimedEvent();
    const harness = transactionHarness(event);
    const executor = createDurableEventConsumerExecutor({
      transactionPort: harness.port,
      consumer: {
        contract: event,
        async apply(scope, current) {
          scope.values.push(current.id);
          return 'applied';
        },
      },
    });

    await expect(executor.execute(event, 150)).resolves.toBe('applied');
    expect(harness.values).toEqual(['event-1']);
    expect(harness.isPublished()).toBe(true);
  });

  it('rolls the local effect back when the consumer fails', async () => {
    const event = claimedEvent();
    const harness = transactionHarness(event);
    const executor = createDurableEventConsumerExecutor({
      transactionPort: harness.port,
      consumer: {
        contract: event,
        async apply(scope) {
          scope.values.push('partial-effect');
          throw new Error('failed after write');
        },
      },
    });

    await expect(executor.execute(event, 150)).rejects.toThrow('failed after write');
    expect(harness.values).toEqual([]);
    expect(harness.isPublished()).toBe(false);
  });

  it('rejects a stale lease before the consumer runs', async () => {
    const event = claimedEvent();
    const harness = transactionHarness({ ...event, leaseToken: 'new-token' });
    const executor = createDurableEventConsumerExecutor({
      transactionPort: harness.port,
      consumer: {
        contract: event,
        async apply(scope) {
          scope.values.push('must-not-run');
          return 'applied';
        },
      },
    });

    await expect(executor.execute(event, 150)).rejects.toBeInstanceOf(DurableEventStaleClaimError);
    expect(harness.values).toEqual([]);
  });

  it('rejects changed payload data before the consumer runs', async () => {
    const event = claimedEvent();
    const corrupt = { ...event, payload: { operationId: 'changed' } };
    const harness = transactionHarness(corrupt);
    const executor = createDurableEventConsumerExecutor({
      transactionPort: harness.port,
      consumer: {
        contract: event,
        async apply(scope) {
          scope.values.push('must-not-run');
          return 'applied';
        },
      },
    });

    await expect(executor.execute(corrupt, 150)).rejects.toBeInstanceOf(
      DurableEventCorruptRecordError,
    );
    expect(harness.values).toEqual([]);
  });
});
