import { describe, expect, it } from 'bun:test';

import type { OperationEventOutboxRecord } from '../../models/OperationEventOutbox';
import type { MintSwapOperation } from '../../operations/mintSwap/MintSwapOperation';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories';
import { makePreparedMintSwapOperation } from '../fixtures/MintSwap';

function makePreparingOperation(overrides: Partial<MintSwapOperation> = {}): MintSwapOperation {
  const prepared = makePreparedMintSwapOperation();
  return {
    id: prepared.id,
    state: 'preparing',
    revision: 0,
    sourceMintUrl: prepared.sourceMintUrl,
    destinationMintUrl: prepared.destinationMintUrl,
    unit: 'sat',
    destinationAmount: prepared.destinationAmount,
    retry: { attemptCount: 0 },
    createdAt: prepared.createdAt,
    updatedAt: prepared.updatedAt,
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<OperationEventOutboxRecord> = {},
): OperationEventOutboxRecord {
  return {
    id: 'event-1',
    operationId: 'swap-1',
    revision: 1,
    eventType: 'mint-swap-op:prepared',
    payload: {
      operationId: 'swap-1',
      revision: 1,
      state: 'prepared',
      sourceMintUrl: 'https://source.test',
      destinationMintUrl: 'https://destination.test',
      unit: 'sat',
      destinationAmount: '100',
    },
    createdAt: 1_700_000_000_001,
    publishAttempts: 0,
    ...overrides,
  };
}

describe('memory mint swap repositories', () => {
  it('allows exactly one compare-and-set winner', async () => {
    const repositories = new MemoryRepositories();
    await repositories.mintSwapOperationRepository.create(makePreparingOperation());
    const next = makePreparedMintSwapOperation();

    const results = await Promise.all([
      repositories.mintSwapOperationRepository.compareAndSet(next, 0),
      repositories.mintSwapOperationRepository.compareAndSet(next, 0),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect((await repositories.mintSwapOperationRepository.getById('swap-1'))?.revision).toBe(1);
  });

  it('enforces unique destination and source child ownership', async () => {
    const repositories = new MemoryRepositories();
    await repositories.mintSwapOperationRepository.create(
      makePreparedMintSwapOperation({ revision: 0 }),
    );

    await expect(
      repositories.mintSwapOperationRepository.create(
        makePreparedMintSwapOperation({ id: 'swap-2', revision: 0 }),
      ),
    ).rejects.toThrow('already owned');
  });

  it('orders due automatic work and excludes prepared and attention states', async () => {
    const repositories = new MemoryRepositories();
    await repositories.mintSwapOperationRepository.create(
      makePreparingOperation({ id: 'late', retry: { attemptCount: 1, nextAttemptAt: 30 } }),
    );
    await repositories.mintSwapOperationRepository.create(
      makePreparingOperation({ id: 'early', retry: { attemptCount: 1, nextAttemptAt: 10 } }),
    );
    await repositories.mintSwapOperationRepository.create(
      makePreparedMintSwapOperation({ id: 'prepared', revision: 0 }),
    );

    expect(
      (await repositories.mintSwapOperationRepository.getDue(30, 10)).map(({ id }) => id),
    ).toEqual(['early', 'late']);
  });

  it('enforces outbox logical uniqueness and tracks durable publication attempts', async () => {
    const repositories = new MemoryRepositories();
    await repositories.operationEventOutboxRepository.enqueue(makeEvent());

    await expect(
      repositories.operationEventOutboxRepository.enqueue(makeEvent({ id: 'event-2' })),
    ).rejects.toThrow('logical key');

    await repositories.operationEventOutboxRepository.recordPublishFailure(
      'event-1',
      1_700_000_000_100,
      'temporarily unavailable',
    );
    expect(
      await repositories.operationEventOutboxRepository.getUnpublished(10, 1_700_000_000_099),
    ).toEqual([]);
    const due = await repositories.operationEventOutboxRepository.getUnpublished(
      10,
      1_700_000_000_100,
    );
    expect(due[0]?.publishAttempts).toBe(1);

    await repositories.operationEventOutboxRepository.markPublished('event-1', 1_700_000_000_101);
    expect(await repositories.operationEventOutboxRepository.getUnpublished(10)).toEqual([]);
  });

  it('stages memory transactions invisibly and rolls all repositories back on error', async () => {
    const repositories = new MemoryRepositories();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let staged = false;

    const transaction = repositories.withTransaction(async (tx) => {
      await tx.mintSwapOperationRepository.create(makePreparingOperation());
      await tx.operationEventOutboxRepository.enqueue(makeEvent());
      staged = true;
      await barrier;
    });
    while (!staged) await Promise.resolve();
    expect(await repositories.mintSwapOperationRepository.getById('swap-1')).toBeNull();
    expect(await repositories.operationEventOutboxRepository.getUnpublished(10)).toEqual([]);
    release();
    await transaction;
    expect(await repositories.mintSwapOperationRepository.getById('swap-1')).not.toBeNull();
    expect(await repositories.operationEventOutboxRepository.getUnpublished(10)).toHaveLength(1);

    await expect(
      repositories.withTransaction(async (tx) => {
        await tx.mintSwapOperationRepository.create(
          makePreparingOperation({ id: 'rolled-back-swap' }),
        );
        await tx.operationEventOutboxRepository.enqueue(
          makeEvent({
            id: 'rolled-back-event',
            operationId: 'rolled-back-swap',
            payload: { ...makeEvent().payload, operationId: 'rolled-back-swap' },
          }),
        );
        throw new Error('injected transaction failure');
      }),
    ).rejects.toThrow('injected');
    expect(await repositories.mintSwapOperationRepository.getById('rolled-back-swap')).toBeNull();
  });
});
