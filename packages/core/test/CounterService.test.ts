import { describe, it, beforeEach, expect } from 'bun:test';
import { CounterService } from '../services/CounterService.ts';
import { MemoryCounterRepository } from '../repositories/memory/MemoryCounterRepository.ts';
import { EventBus } from '../events/EventBus.ts';
import type { CoreEvents } from '../events/types.ts';

describe('CounterService', () => {
  const mintUrl = 'https://mint.test';
  const keysetId = 'keyset-1';

  let repo: MemoryCounterRepository;
  let bus: EventBus<CoreEvents>;
  let service: CounterService;

  beforeEach(() => {
    repo = new MemoryCounterRepository();
    bus = new EventBus<CoreEvents>();
    service = new CounterService(repo, undefined, bus);
  });

  it('initializes counter to zero on first getCounter()', async () => {
    const result = await service.getCounter(mintUrl, keysetId);
    expect(result.counter).toBe(0);

    const fromRepo = await repo.getCounter(mintUrl, keysetId);
    expect(fromRepo?.counter).toBe(0);
  });

  it('incrementCounter increases value and emits counter:updated', async () => {
    const events: Array<{ mintUrl: string; keysetId: string; counter: number }> = [];
    bus.on('counter:updated', (payload) => {
      events.push(payload);
    });

    const updated = await service.incrementCounter(mintUrl, keysetId, 3);
    expect(updated.counter).toBe(3);

    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ mintUrl, keysetId, counter: 3 });
  });

  it('overwriteCounter sets value and emits counter:updated', async () => {
    const events: Array<{ mintUrl: string; keysetId: string; counter: number }> = [];
    bus.on('counter:updated', (payload) => {
      events.push(payload);
    });

    await service.incrementCounter(mintUrl, keysetId, 2);
    const updated = await service.overwriteCounter(mintUrl, keysetId, 42);

    expect(updated.counter).toBe(42);

    const fromRepo = await repo.getCounter(mintUrl, keysetId);
    expect(fromRepo?.counter).toBe(42);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]).toEqual({ mintUrl, keysetId, counter: 42 });
  });

  it('accumulates multiple increments', async () => {
    await service.incrementCounter(mintUrl, keysetId, 1);
    await service.incrementCounter(mintUrl, keysetId, 2);

    const final = await repo.getCounter(mintUrl, keysetId);
    expect(final?.counter).toBe(3);
  });

  it('rejects negative increment values', async () => {
    await expect(service.incrementCounter(mintUrl, keysetId, -1)).rejects.toThrow(
      'n must be a non-negative integer',
    );
  });

  it('rejects float increment values', async () => {
    await expect(service.incrementCounter(mintUrl, keysetId, 1.5)).rejects.toThrow(
      'n must be a non-negative integer',
    );
  });

  it('rejects negative overwrite values', async () => {
    await expect(service.overwriteCounter(mintUrl, keysetId, -10)).rejects.toThrow(
      'counter must be a non-negative integer',
    );
  });

  it('rejects float overwrite values', async () => {
    await expect(service.overwriteCounter(mintUrl, keysetId, 3.14)).rejects.toThrow(
      'counter must be a non-negative integer',
    );
  });
});
