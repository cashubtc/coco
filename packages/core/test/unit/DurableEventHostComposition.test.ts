import { describe, expect, it } from 'bun:test';
import {
  MemoryDurableEventOutboxRepository,
  createDurableEventConsumerExecutor,
} from '../../outbox/index.ts';
import type {
  ClaimedDurableEvent,
  DurableEventConsumerTransactionPort,
  DurableEventRevisionBatch,
} from '../../outbox/index.ts';

interface HostState {
  revision: number;
  projectedEventIds: string[];
}

function revisionBatch(): DurableEventRevisionBatch {
  return {
    streamId: 'operation-1',
    expectedPreviousRevision: 0,
    streamRevision: 1,
    events: [
      {
        id: 'event-1',
        envelopeVersion: 1,
        eventKey: 'project-history',
        eventType: 'wallet.operation.finalized',
        consumerId: 'wallet.history.projector',
        streamId: 'operation-1',
        streamRevision: 1,
        payloadVersion: 1,
        payload: { operationId: 'operation-1' },
        occurredAt: 100,
      },
    ],
  };
}

function createHostFixture() {
  const outbox = new MemoryDurableEventOutboxRepository();
  let state: HostState = { revision: 0, projectedEventIds: [] };

  async function runTransaction<T>(
    work: (scope: { state: HostState; outbox: MemoryDurableEventOutboxRepository }) => Promise<T>,
  ): Promise<T> {
    const stagedState: HostState = {
      revision: state.revision,
      projectedEventIds: [...state.projectedEventIds],
    };
    const stagedOutbox = outbox.clone();
    const result = await work({ state: stagedState, outbox: stagedOutbox });
    outbox.replaceWith(stagedOutbox);
    state = stagedState;
    return result;
  }

  const consumerTransactions: DurableEventConsumerTransactionPort<HostState> = {
    run(work) {
      return runTransaction(({ state: effect, outbox }) => work({ effect, outbox }));
    },
  };

  return { outbox, getState: () => state, runTransaction, consumerTransactions };
}

async function claim(outbox: MemoryDurableEventOutboxRepository): Promise<ClaimedDurableEvent> {
  const claimed = await outbox.claimNext({
    workerId: 'worker-1',
    leaseToken: 'lease-1',
    leaseDurationMs: 1_000,
    now: 200,
    contracts: [revisionBatch().events[0]!],
  });
  if (!claimed) throw new Error('expected an event claim');
  return claimed;
}

describe('generic durable event host composition', () => {
  it('commits producer state and its sealed event batch together', async () => {
    const host = createHostFixture();

    await host.runTransaction(async ({ state, outbox }) => {
      state.revision = 1;
      await outbox.enqueueRevision(revisionBatch(), 100);
    });

    expect(host.getState().revision).toBe(1);
    expect((await host.outbox.getStorageStats()).eventRows).toBe(1);
  });

  it('rolls producer state and its event batch back together', async () => {
    const host = createHostFixture();

    await expect(
      host.runTransaction(async ({ state, outbox }) => {
        state.revision = 1;
        await outbox.enqueueRevision(revisionBatch(), 100);
        throw new Error('abort producer transaction');
      }),
    ).rejects.toThrow('abort producer transaction');

    expect(host.getState().revision).toBe(0);
    expect((await host.outbox.getStorageStats()).eventRows).toBe(0);
  });

  it('reuses stable producer inputs when a host retries an uncommitted transaction', async () => {
    const host = createHostFixture();
    const batch = revisionBatch();
    let attempt = 0;

    while (true) {
      try {
        await host.runTransaction(async ({ state, outbox }) => {
          state.revision = 1;
          const result = await outbox.enqueueRevision(batch, 100);
          expect(result.eventIds).toEqual(['event-1']);
          attempt += 1;
          if (attempt === 1) throw new Error('confirmed uncommitted conflict');
        });
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'confirmed uncommitted conflict') {
          throw error;
        }
      }
    }

    expect(attempt).toBe(2);
    expect(host.getState().revision).toBe(1);
    expect((await host.outbox.getStorageStats()).eventRows).toBe(1);
    expect((await host.outbox.getStorageStats()).revisionSeals).toBe(1);
  });

  it('commits a local consumer effect and publication together', async () => {
    const host = createHostFixture();
    await host.runTransaction(async ({ state, outbox }) => {
      state.revision = 1;
      await outbox.enqueueRevision(revisionBatch(), 100);
    });
    const event = await claim(host.outbox);
    const executor = createDurableEventConsumerExecutor({
      transactionPort: host.consumerTransactions,
      consumer: {
        contract: event,
        async apply(state, current) {
          state.projectedEventIds.push(current.id);
          return 'applied';
        },
      },
    });

    await expect(executor.execute(event, 250)).resolves.toBe('applied');
    expect(host.getState().projectedEventIds).toEqual(['event-1']);
    expect(await host.outbox.readAndValidateCurrentClaim(event)).toBeNull();
  });

  it('rolls a partial local consumer effect and publication back together', async () => {
    const host = createHostFixture();
    await host.runTransaction(async ({ state, outbox }) => {
      state.revision = 1;
      await outbox.enqueueRevision(revisionBatch(), 100);
    });
    const event = await claim(host.outbox);
    const executor = createDurableEventConsumerExecutor({
      transactionPort: host.consumerTransactions,
      consumer: {
        contract: event,
        async apply(state, current) {
          state.projectedEventIds.push(current.id);
          throw new Error('abort consumer transaction');
        },
      },
    });

    await expect(executor.execute(event, 250)).rejects.toThrow('abort consumer transaction');
    expect(host.getState().projectedEventIds).toEqual([]);
    expect(await host.outbox.readAndValidateCurrentClaim(event)).not.toBeNull();
  });
});
