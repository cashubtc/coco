import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { MintSwapOperationProcessor } from '../../services/watchers/MintSwapOperationProcessor.ts';
import { mintSwapFixtures } from '../fixtures/MintSwap.ts';
import { mintSwapFixture } from '../../../adapter-tests/src/internal/mintSwap/fixture.ts';
import { beginMeltExecution } from '../../operations/melt/MeltTransitions.ts';
import {
  beginMintSwapSource,
  deferMintSwap,
} from '../../operations/mintSwap/MintSwapTransitions.ts';
import { deferred } from '../fixtures/MintSwapRuntime.ts';

describe('Mint Swap automatic recovery', () => {
  const processors: MintSwapOperationProcessor[] = [];
  afterEach(async () => {
    await Promise.all(processors.splice(0).map((processor) => processor.stop()));
    mock.restore();
  });
  function processor(...args: ConstructorParameters<typeof MintSwapOperationProcessor>) {
    const value = new MintSwapOperationProcessor(...args);
    processors.push(value);
    return value;
  }

  it('visits the complete eligible snapshot past a failing first batch', async () => {
    const repo = new MemoryRepositories();
    for (let index = 0; index < 60; index++) {
      await repo.mintSwap.operationRepository.create(
        mintSwapFixtures(`swap-${String(index).padStart(2, '0')}`).preparing,
      );
    }
    const visited: string[] = [];
    const runtime = processor(
      {
        reconcileInBackground: async (id) => {
          visited.push(id);
          if (visited.length <= 25) throw new Error('one row unavailable');
        },
      },
      repo.mintSwap.operationRepository,
      new EventBus<CoreEvents>(),
    );
    await runtime.start();
    expect(visited).toHaveLength(60);
    expect(visited.at(-1)).toBe('swap-59');
  });

  it('adopts a prepared parent whose child advanced with every event lost', async () => {
    const fixture = await mintSwapFixture(new MemoryRepositories());
    await fixture.create();
    await fixture.prepare();
    // An ordinary child command has advanced while the parent is still prepared.
    await fixture.runner.run((tx) =>
      tx.perform(beginMeltExecution, { operationId: 'source-child', now: 1001 }),
    );
    fixture.setDestinationState('ISSUED');
    fixture.setTime(2000);
    const runtime = processor(
      fixture.service(),
      fixture.repositories.mintSwap.operationRepository,
      new EventBus<CoreEvents>(),
    );
    await runtime.start();
    expect((await fixture.repositories.mintSwap.operationRepository.getById('swap'))?.state).toBe(
      'completed',
    );
    expect(fixture.requests).not.toContain('melt');
  });

  it('rechecks future Retry-After under the parent lock for stale scan candidates', async () => {
    const fixture = await mintSwapFixture(new MemoryRepositories());
    await fixture.create();
    await fixture.prepare();
    const stale = await fixture.repositories.mintSwap.operationRepository.listActive();
    await fixture.runner.run((tx) =>
      tx.perform(beginMintSwapSource, { ...fixture.preparation, now: 1001 }),
    );
    await fixture.runner.run((tx) =>
      tx.perform(deferMintSwap, {
        id: 'swap',
        now: 1002,
        random: 0.5,
        retryAfter: 99_000,
        error: { category: 'transient', code: 'remote_unavailable' },
      }),
    );
    const before = await fixture.repositories.mintSwap.operationRepository.getById('swap');
    const runtime = processor(
      fixture.service(),
      {
        listActive: async () => stale,
        listDue: async () => stale,
      },
      fixture.events,
    );
    await runtime.start();
    expect(await fixture.repositories.mintSwap.operationRepository.getById('swap')).toEqual(before);
    expect(fixture.requests).toEqual([]);
  });

  it('skips busy parent/child work and does not change its retry evidence', async () => {
    const fixture = await mintSwapFixture(new MemoryRepositories());
    await fixture.create();
    await fixture.prepare();
    const service = fixture.service();
    const entered = deferred();
    const release = deferred();
    const preflight = fixture.dependencies.mintService.refreshAndCommitIfStale;
    fixture.dependencies.mintService.refreshAndCommitIfStale = async (url) => {
      entered.resolve();
      await release.promise;
      return preflight(url);
    };
    const command = service.execute('swap');
    await entered.promise;
    await service.reconcileInBackground('swap');
    const before = await service.getOperation('swap');
    expect(before?.state).toBe('prepared');
    release.resolve();
    await command;
    const unlock = await fixture.dependencies.sourceOperationLock.acquire('source-child');
    const current = await service.getOperation('swap');
    await service.reconcileInBackground('swap');
    expect(await service.getOperation('swap')).toEqual(current);
    unlock();
  });

  it('coalesces hints without inline reconciliation and preserves persisted due time', async () => {
    const fixture = await mintSwapFixture(new MemoryRepositories());
    await fixture.create();
    await fixture.prepare();
    const service = fixture.service();
    const reached = deferred();
    const original = service.reconcileInBackground.bind(service);
    let calls = 0;
    let notify = false;
    spyOn(service, 'reconcileInBackground').mockImplementation(async (id) => {
      calls++;
      await original(id);
      if (notify) reached.resolve();
    });
    const runtime = processor(
      service,
      fixture.repositories.mintSwap.operationRepository,
      fixture.events,
      undefined,
      { processIntervalMs: 5 },
    );
    await runtime.start();
    const count = calls;
    fixture.events.on('mint-swap:updated', () => {
      expect(calls).toBe(count);
    });
    for (let index = 0; index < 8; index++)
      await fixture.events.emit('mint-swap:updated', {
        operationId: 'swap',
        revision: 1,
        state: 'prepared',
      });
    notify = true;
    await reached.promise;
    expect((await service.getOperation('swap'))?.state).toBe('prepared');
    expect(fixture.requests).toEqual([]);
  });

  it('stops during discovery and ignores callbacks already snapshotted by EventBus', async () => {
    const repo = new MemoryRepositories();
    const events = new EventBus<CoreEvents>();
    const listenerEntered = deferred();
    const releaseListener = deferred();
    events.on('mint-swap:updated', async () => {
      listenerEntered.resolve();
      await releaseListener.promise;
    });
    const scanEntered = deferred();
    const releaseScan = deferred();
    const reconcile = mock(async () => {});
    const runtime = processor(
      { reconcileInBackground: reconcile },
      {
        listActive: async () => {
          scanEntered.resolve();
          await releaseScan.promise;
          return [mintSwapFixtures().prepared];
        },
        listDue: (now, limit) => repo.mintSwap.operationRepository.listDue(now, limit),
      },
      events,
    );
    const started = runtime.start();
    await scanEntered.promise;
    const emission = events.emit('mint-swap:updated', {
      operationId: 'swap',
      revision: 1,
      state: 'prepared',
    });
    await listenerEntered.promise;
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseScan.resolve();
    await started;
    await stopping;
    releaseListener.resolve();
    await emission;
    expect(reconcile).not.toHaveBeenCalled();
    expect(runtime.isRunning()).toBe(false);
  });

  it('does not schedule a retry when a child becomes busy after the background check', async () => {
    const fixture = await mintSwapFixture(new MemoryRepositories());
    await fixture.create();
    const before = await fixture.repositories.mintSwap.operationRepository.getById('swap');
    const sourceLock = fixture.dependencies.sourceOperationLock;
    const acquire = sourceLock.acquire.bind(sourceLock);
    let releaseDestination: (() => void) | undefined;
    spyOn(sourceLock, 'acquire').mockImplementation(async (id) => {
      const release = await acquire(id);
      releaseDestination =
        await fixture.dependencies.destinationOperationLock.acquire('destination-child');
      return release;
    });
    try {
      await fixture.service().reconcileInBackground('swap');
      expect(await fixture.repositories.mintSwap.operationRepository.getById('swap')).toEqual(
        before,
      );
      expect(sourceLock.isLocked('source-child')).toBe(false);
    } finally {
      releaseDestination?.();
    }
  });

  it('continues ordinary due discovery after a failed complete enumeration', async () => {
    const repo = new MemoryRepositories();
    await repo.mintSwap.operationRepository.create(mintSwapFixtures().preparing);
    const reached = deferred();
    const runtime = processor(
      {
        reconcileInBackground: async () => {
          reached.resolve();
        },
      },
      {
        listActive: async () => {
          throw new Error('active row unreadable');
        },
        listDue: (now, limit) => repo.mintSwap.operationRepository.listDue(now, limit),
      },
      new EventBus<CoreEvents>(),
      undefined,
      { processIntervalMs: 5 },
    );
    await runtime.start();
    await reached.promise;
    expect(runtime.isRunning()).toBe(true);
  });

  it('drains due discovery on disposal and closes later recovery admission', async () => {
    const fixture = await mintSwapFixture(new MemoryRepositories());
    await fixture.create();
    const service = fixture.service();
    const queries = fixture.repositories.mintSwap.operationRepository;
    const listDue = queries.listDue.bind(queries);
    const entered = deferred();
    const release = deferred();
    const discovery = mock(async (now: number, limit: number) => {
      const candidates = await listDue(now, limit);
      entered.resolve();
      await release.promise;
      return candidates;
    });
    fixture.dependencies.parentQueries = {
      getById: queries.getById.bind(queries),
      listActive: queries.listActive.bind(queries),
      listDue: discovery,
    };
    const recovery = service.recoverDue().then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    let disposed = false;
    const disposal = service.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const disposedBeforeDiscovery = disposed;
    release.resolve();
    const [error] = await Promise.all([recovery, disposal]);
    expect(disposedBeforeDiscovery).toBe(false);
    expect(error).toBeUndefined();
    expect((await queries.getById('swap'))?.state).toBe('preparing');
    expect(fixture.requests).toEqual([]);
    await expect(service.recoverDue()).rejects.toThrow('disposed');
    expect(discovery).toHaveBeenCalledTimes(1);
  });

  it('drains its current worker before stop and resumes only a new generation', async () => {
    const repo = new MemoryRepositories();
    await repo.mintSwap.operationRepository.create(mintSwapFixtures().prepared);
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const runtime = processor(
      {
        reconcileInBackground: async () => {
          calls++;
          entered.resolve();
          await release.promise;
        },
      },
      repo.mintSwap.operationRepository,
      new EventBus<CoreEvents>(),
    );
    const first = runtime.start();
    await entered.promise;
    const duplicate = runtime.start();
    const stop = runtime.stop();
    const overlapping = runtime.start();
    release.resolve();
    await Promise.all([first, duplicate, stop, overlapping]);
    expect(calls).toBe(1);
    expect(runtime.isRunning()).toBe(false);
    await runtime.start();
    expect(calls).toBe(2);
  });
});
