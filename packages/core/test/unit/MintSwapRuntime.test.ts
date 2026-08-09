import { describe, expect, it, mock } from 'bun:test';

import { EventBus, type CoreEvents } from '../../events';
import type { MintSwapOperationService } from '../../operations/mintSwap/MintSwapOperationService.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { OperationEventOutboxPublisher } from '../../services/OperationEventOutboxPublisher.ts';
import { MintSwapOperationProcessor } from '../../services/watchers/MintSwapOperationProcessor.ts';
import {
  MINT_SWAP_TEST_NOW,
  makeMintSwapOutboxRecord,
  makePreparingMintSwapOperation,
} from '../fixtures/MintSwap.ts';

describe('Mint Swap runtime', () => {
  it('recovers a due operation from the durable scan without a wake-up event', async () => {
    const repositories = new MemoryRepositories();
    const operation = makePreparingMintSwapOperation();
    await repositories.mintSwap!.mintSwapOperationRepository.create(operation);
    const reconcile = mock(async () => operation);
    const service = {
      reconcile,
      recordProcessorSuccess: mock(async () => false),
      recordProcessorFailure: mock(async () => false),
      get: mock(async () => operation),
    } as unknown as MintSwapOperationService;
    const processor = new MintSwapOperationProcessor(
      service,
      repositories,
      new EventBus<CoreEvents>(),
      undefined,
      { now: () => MINT_SWAP_TEST_NOW + 30_001, sweepIntervalMs: 60_000 },
    );

    await processor.start();
    await processor.stop();

    expect(reconcile).toHaveBeenCalledWith(operation.id);
  });

  it('lets the atomic service command reject a terminal-vs-failure race', async () => {
    const repositories = new MemoryRepositories();
    const operation = makePreparingMintSwapOperation();
    await repositories.mintSwap!.mintSwapOperationRepository.create(operation);
    const recordProcessorFailure = mock(async () => false);
    const service = {
      reconcile: mock(async () => {
        throw new Error('temporary failure');
      }),
      get: mock(async () => operation),
      recordProcessorFailure,
      recordProcessorSuccess: mock(async () => false),
    } as unknown as MintSwapOperationService;
    const processor = new MintSwapOperationProcessor(
      service,
      repositories,
      new EventBus<CoreEvents>(),
      undefined,
      {
        now: () => MINT_SWAP_TEST_NOW + 30_001,
        random: () => 0.5,
        sweepIntervalMs: 60_000,
      },
    );

    await processor.start();
    await processor.stop();

    expect(recordProcessorFailure).toHaveBeenCalledTimes(1);
    expect(recordProcessorFailure).toHaveBeenCalledWith(operation.id, MINT_SWAP_TEST_NOW + 30_501);
  });

  it('retries listener failures and publishes the committed event later', async () => {
    const repositories = new MemoryRepositories();
    const repository = repositories.mintSwap!.operationEventOutboxRepository;
    const record = makeMintSwapOutboxRecord();
    await repository.enqueue(record);
    const bus = new EventBus<CoreEvents>();
    let shouldFail = true;
    let observed = 0;
    bus.on(record.eventType, () => {
      observed += 1;
      if (shouldFail) throw new Error('listener unavailable');
    });
    const publisher = new OperationEventOutboxPublisher(repository, bus, undefined, {
      now: () => MINT_SWAP_TEST_NOW,
      random: () => 0.5,
    });

    await publisher.publishDue(MINT_SWAP_TEST_NOW);
    const failed = await repository.getById(record.id);
    expect(failed).toMatchObject({
      publishAttempts: 1,
      nextAttemptAt: MINT_SWAP_TEST_NOW + 500,
      lastError: 'Mint swap event publication failed; retry is scheduled',
    });

    shouldFail = false;
    await publisher.publishDue(MINT_SWAP_TEST_NOW + 500);
    expect(await repository.getById(record.id)).toMatchObject({
      publishAttempts: 2,
      publishedAt: MINT_SWAP_TEST_NOW + 500,
    });
    expect(observed).toBe(2);
  });

  it('continues publishing the outbox when parent reconciliation is disabled', async () => {
    const repositories = new MemoryRepositories();
    const operation = makePreparingMintSwapOperation();
    const record = makeMintSwapOutboxRecord();
    await repositories.mintSwap!.mintSwapOperationRepository.create(operation);
    await repositories.mintSwap!.operationEventOutboxRepository.enqueue(record);
    const bus = new EventBus<CoreEvents>();
    const observed = mock(() => undefined);
    bus.on(record.eventType, observed);
    const reconcile = mock(async () => operation);
    const service = {
      reconcile,
      recordProcessorSuccess: mock(async () => false),
      recordProcessorFailure: mock(async () => false),
      get: mock(async () => operation),
    } as unknown as MintSwapOperationService;
    const processor = new MintSwapOperationProcessor(service, repositories, bus, undefined, {
      now: () => MINT_SWAP_TEST_NOW + 30_001,
      sweepIntervalMs: 60_000,
      reconciliationDisabled: true,
    });

    await processor.start();
    await processor.stop();

    expect(reconcile).not.toHaveBeenCalled();
    expect(observed).toHaveBeenCalledTimes(1);
    expect(
      await repositories.mintSwap!.operationEventOutboxRepository.getById(record.id),
    ).toHaveProperty('publishedAt', MINT_SWAP_TEST_NOW + 30_001);
  });
});
