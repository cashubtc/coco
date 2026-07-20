import { describe, expect, it, mock } from 'bun:test';

import { EventBus, type CoreEvents } from '../../events/index.ts';
import type { OperationEventOutboxRecord } from '../../models/OperationEventOutbox.ts';
import type { MintSwapOperationService } from '../../operations/mintSwap/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { OperationEventOutboxPublisher } from '../../services/OperationEventOutboxPublisher.ts';
import { MintSwapOperationProcessor } from '../../services/watchers/MintSwapOperationProcessor.ts';
import { makePreparedMintSwapOperation } from '../fixtures/MintSwap.ts';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('OperationEventOutboxPublisher', () => {
  it('publishes a durable event once and marks it only after listeners complete', async () => {
    const repositories = new MemoryRepositories();
    const bus = new EventBus<CoreEvents>();
    const seen: number[] = [];
    bus.on('mint-swap-op:completed', ({ revision }) => {
      seen.push(revision);
    });
    await repositories.operationEventOutboxRepository.enqueue(makeOutbox());

    const publisher = new OperationEventOutboxPublisher(
      repositories.operationEventOutboxRepository,
      bus,
    );
    expect(await publisher.publishDue()).toBe(1);
    expect(await publisher.publishDue()).toBe(0);
    expect(seen).toEqual([4]);
  });

  it('persists publication backoff and replays after a listener failure', async () => {
    const repositories = new MemoryRepositories();
    const bus = new EventBus<CoreEvents>();
    let fail = true;
    bus.on('mint-swap-op:completed', () => {
      if (fail) throw new Error('listener unavailable');
    });
    await repositories.operationEventOutboxRepository.enqueue(makeOutbox());
    const publisher = new OperationEventOutboxPublisher(
      repositories.operationEventOutboxRepository,
      bus,
      undefined,
      { baseRetryDelayMs: 10 },
    );

    await publisher.publishDue(100);
    expect(await repositories.operationEventOutboxRepository.getUnpublished(10, 100)).toHaveLength(
      0,
    );
    fail = false;
    expect(await publisher.publishDue(110)).toBe(1);
    expect(await publisher.publishDue(111)).toBe(0);
  });
});

describe('MintSwapOperationProcessor', () => {
  it('sweeps durable due work even when no wake-up event was observed', async () => {
    const repositories = new MemoryRepositories();
    await repositories.mintSwapOperationRepository.create(
      makePreparedMintSwapOperation({
        state: 'source_inflight',
        revision: 0,
        sourceDispatchAuthorizedAt: Date.now(),
      }),
    );
    const refresh = mock(async () => makePreparedMintSwapOperation({ state: 'completed' }));
    const service = {
      refresh,
      get: mock(async () => null),
      recordProcessorSuccess: mock(async () => makePreparedMintSwapOperation()),
      recordProcessorFailure: mock(async () => makePreparedMintSwapOperation()),
    } as unknown as MintSwapOperationService;
    const processor = new MintSwapOperationProcessor(
      service,
      repositories,
      new EventBus<CoreEvents>(),
      undefined,
      { sweepIntervalMs: 60_000 },
    );

    await processor.start();
    await tick();
    await processor.stop();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('persists exponential retry timing without converting ambiguity into attention', async () => {
    const repositories = new MemoryRepositories();
    const operation = makePreparedMintSwapOperation({
      state: 'source_inflight',
      revision: 0,
      sourceDispatchAuthorizedAt: Date.now(),
    });
    await repositories.mintSwapOperationRepository.create(operation);
    const recordFailure = mock(async (_id: string, _error: string, _nextAttemptAt: number) =>
      Promise.resolve(operation),
    );
    const service = {
      refresh: mock(async () => {
        throw new Error('mint temporarily unavailable');
      }),
      get: mock(async () => operation),
      recordProcessorSuccess: mock(async () => operation),
      recordProcessorFailure: recordFailure,
    } as unknown as MintSwapOperationService;
    const processor = new MintSwapOperationProcessor(
      service,
      repositories,
      new EventBus<CoreEvents>(),
      undefined,
      { sweepIntervalMs: 60_000, baseRetryDelayMs: 100 },
    );

    const before = Date.now();
    await processor.start();
    await tick();
    await processor.stop();
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure.mock.calls[0]![2]).toBeGreaterThanOrEqual(before + 100);
  });
});

function makeOutbox(): OperationEventOutboxRecord {
  return {
    id: 'event-1',
    operationId: 'swap-1',
    revision: 4,
    eventType: 'mint-swap-op:completed',
    payload: {
      operationId: 'swap-1',
      revision: 4,
      state: 'completed',
      sourceMintUrl: 'https://source.test',
      destinationMintUrl: 'https://destination.test',
      unit: 'sat',
      destinationAmount: '100',
    },
    createdAt: 1,
    publishAttempts: 0,
  };
}
