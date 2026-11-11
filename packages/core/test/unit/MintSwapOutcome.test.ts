import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { waitForMintSwapOutcome } from '../../api/MintSwapOutcome.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { mintSwapFixtures } from '../fixtures/MintSwap.ts';
import { mintSwapFixture } from '../../../adapter-tests/src/internal/mintSwap/fixture.ts';
import { deferred } from '../fixtures/MintSwapRuntime.ts';

describe('Mint Swap outcome observation', () => {
  const disposals: AbortController[] = [];
  afterEach(() => {
    for (const controller of disposals.splice(0)) controller.abort(new Error('test disposal'));
    mock.restore();
  });
  function signal() {
    const controller = new AbortController();
    disposals.push(controller);
    return controller;
  }

  for (const state of ['completed', 'cancelled', 'failed', 'needs_attention'] as const) {
    it(`returns an already persisted ${state} without waiting or mutating it`, async () => {
      const repo = new MemoryRepositories();
      const operation = mintSwapFixtures()[state];
      await repo.mintSwap.operationRepository.create(operation);
      const result = await waitForMintSwapOutcome(
        'swap',
        (id) => repo.mintSwap.operationRepository.getById(id),
        new EventBus<CoreEvents>(),
        signal().signal,
        { timeoutMs: 0 },
      );
      expect(result.status).toBe(state);
      expect(result.operation).toEqual(operation);
    });
  }

  it('polls to find completion when every event is lost', async () => {
    const fixture = await mintSwapFixture(new MemoryRepositories());
    await fixture.create();
    await fixture.prepare();
    fixture.setDestinationState('ISSUED');
    const observerBus = new EventBus<CoreEvents>(); // Deliberately disconnected from publication.
    const waiting = waitForMintSwapOutcome(
      'swap',
      (id) => fixture.repositories.mintSwap.operationRepository.getById(id),
      observerBus,
      signal().signal,
      { pollIntervalMs: 5, timeoutMs: 1000 },
    );
    await fixture.service().execute('swap');
    const result = await waiting;
    expect(result.status).toBe('completed');
    expect(fixture.requests.filter((request) => request === 'melt')).toHaveLength(1);
  });

  it('closes the initial read/subscription gap without relying on a later event', async () => {
    const fixture = await mintSwapFixture(new MemoryRepositories());
    await fixture.create();
    await fixture.prepare();
    fixture.setDestinationState('ISSUED');
    const get = fixture.repositories.mintSwap.operationRepository.getById.bind(
      fixture.repositories.mintSwap.operationRepository,
    );
    let first = true;
    const waiting = waitForMintSwapOutcome(
      'swap',
      async (id) => {
        const snapshot = await get(id);
        if (first) {
          first = false;
          await fixture.service().execute(id);
        }
        return snapshot;
      },
      fixture.events,
      signal().signal,
      { pollIntervalMs: 100_000 },
    );
    expect((await waiting).status).toBe('completed');
  });

  it('performs a final read after the deadline overtakes an in-flight read', async () => {
    const fixture = await mintSwapFixture(new MemoryRepositories());
    await fixture.create();
    await fixture.prepare();
    fixture.setDestinationState('ISSUED');
    const old = await fixture.repositories.mintSwap.operationRepository.getById('swap');
    const entered = deferred();
    const release = deferred();
    let elapsed = 0;
    spyOn(performance, 'now').mockImplementation(() => elapsed);
    let timeout!: () => void;
    const schedule = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      timeout = callback;
      return 123;
    }) as unknown as typeof setTimeout);
    let reads = 0;
    const waiting = waitForMintSwapOutcome(
      'swap',
      async () => {
        reads++;
        if (reads === 1) {
          entered.resolve();
          await release.promise;
          return old;
        }
        return fixture.repositories.mintSwap.operationRepository.getById('swap');
      },
      fixture.events,
      signal().signal,
      { timeoutMs: 10, pollIntervalMs: 100_000 },
    );
    await entered.promise;
    elapsed = 10;
    timeout();
    schedule.mockRestore();
    await fixture.service().execute('swap');
    release.resolve();
    expect((await waiting).status).toBe('completed');
    expect(reads).toBe(2);
  });

  it('timeout is an observation result and does not drive recovery', async () => {
    const fixture = await mintSwapFixture(new MemoryRepositories());
    await fixture.create();
    await fixture.prepare();
    const before = await fixture.repositories.mintSwap.operationRepository.getById('swap');
    const result = await waitForMintSwapOutcome(
      'swap',
      (id) => fixture.repositories.mintSwap.operationRepository.getById(id),
      fixture.events,
      signal().signal,
      { timeoutMs: 0 },
    );
    expect(result.status).toBe('timeout');
    expect(result.operation).toEqual(before!);
    expect(fixture.requests).toEqual([]);
  });

  for (const mode of ['abort', 'dispose', 'read-error', 'missing'] as const) {
    it(`cleans up on ${mode}, including late reads`, async () => {
      const events = new EventBus<CoreEvents>();
      const controller = signal();
      const abort = signal();
      const entered = deferred();
      const release = deferred();
      let reads = 0;
      const waiting = waitForMintSwapOutcome(
        'swap',
        async () => {
          reads++;
          entered.resolve();
          await release.promise;
          if (mode === 'read-error') throw new Error('read failed');
          if (mode === 'missing') return null;
          return mintSwapFixtures().completed;
        },
        events,
        controller.signal,
        { signal: abort.signal, pollIntervalMs: 100_000 },
      );
      const rejected = waiting.then(
        () => new Error('unexpected success'),
        (error: unknown) => error,
      );
      await entered.promise;
      if (mode === 'abort') abort.abort(new Error('abort'));
      if (mode === 'dispose') controller.abort(new Error('dispose'));
      release.resolve();
      const error = await rejected;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        mode === 'missing' ? 'not found' : mode === 'read-error' ? 'read failed' : mode,
      );
      await events.emit('mint-swap:updated', {
        operationId: 'swap',
        revision: 9,
        state: 'completed',
      });
      expect(reads).toBe(1);
    });
  }

  it('rejects invalid options and pre-aborted waits before any read', async () => {
    const get = mock(async () => mintSwapFixtures().prepared);
    const events = new EventBus<CoreEvents>();
    for (const options of [{ timeoutMs: -1 }, { timeoutMs: Infinity }, { pollIntervalMs: 0 }])
      await expect(
        waitForMintSwapOutcome('swap', get, events, signal().signal, options),
      ).rejects.toThrow();
    const abort = signal();
    abort.abort(new Error('already aborted'));
    await expect(
      waitForMintSwapOutcome('swap', get, events, signal().signal, { signal: abort.signal }),
    ).rejects.toThrow('already aborted');
    expect(get).not.toHaveBeenCalled();
  });
});
