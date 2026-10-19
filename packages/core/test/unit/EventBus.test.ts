import { describe, expect, it, mock } from 'bun:test';
import { EventBus, type EventBusOptions } from '../../events/EventBus.ts';

type Events = { message: string };

describe('EventBus', () => {
  it('awaits each listener before invoking the next one', async () => {
    const bus = new EventBus<Events>();
    const calls: string[] = [];
    const gate = Promise.withResolvers<void>();
    bus.on('message', async (payload) => {
      calls.push(`first:${payload}`);
      await gate.promise;
      calls.push('first:finished');
    });
    bus.on('message', (payload) => {
      calls.push(`second:${payload}`);
    });

    const emitted = bus.emit('message', 'hello');
    expect(calls).toEqual(['first:hello']);
    gate.resolve();
    await emitted;
    expect(calls).toEqual(['first:hello', 'first:finished', 'second:hello']);
  });

  it('reports synchronous and asynchronous failures and continues delivery by default', async () => {
    const onError = mock<NonNullable<EventBusOptions<Events>['onError']>>(() => {});
    const bus = new EventBus<Events>({ onError });
    const syncError = new Error('sync');
    const asyncError = new Error('async');
    const sibling = mock(() => {});
    bus.on('message', () => {
      throw syncError;
    });
    bus.on('message', async () => {
      throw asyncError;
    });
    bus.on('message', sibling);

    await expect(bus.emit('message', 'hello')).resolves.toBeUndefined();
    expect(onError.mock.calls).toEqual([
      [{ event: 'message', payload: 'hello', error: syncError }],
      [{ event: 'message', payload: 'hello', error: asyncError }],
    ]);
    expect(sibling).toHaveBeenCalledTimes(1);
  });

  it('aggregates original listener errors after all listeners finish when requested', async () => {
    const bus = new EventBus<Events>({ throwOnError: true });
    const syncError = new Error('sync');
    const asyncError = new Error('async');
    const calls: string[] = [];
    bus.on('message', () => {
      throw syncError;
    });
    bus.on('message', async () => {
      throw asyncError;
    });
    bus.on('message', async () => {
      await Promise.resolve();
      calls.push('finished');
    });

    const error = await bus.emit('message', 'hello').catch((error: unknown) => error);
    expect(calls).toEqual(['finished']);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBe(syncError);
    expect((error as AggregateError).errors[1]).toBe(asyncError);
    expect((error as AggregateError).errors).toHaveLength(2);
  });

  it('reports the first error and stops delivery when failFast and throwOnError are enabled', async () => {
    const onError = mock<NonNullable<EventBusOptions<Events>['onError']>>(() => {});
    const bus = new EventBus<Events>({ onError, throwOnError: true });
    const failure = new Error('listener');
    const sibling = mock(() => {});
    bus.on('message', () => {
      throw failure;
    });
    bus.on('message', sibling);

    await expect(bus.emit('message', 'hello', { failFast: true })).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith({ event: 'message', payload: 'hello', error: failure });
    expect(sibling).not.toHaveBeenCalled();
  });
  it('cancels future listeners without waiting for the running listener to finish', async () => {
    const bus = new EventBus<Events>();
    const controller = new AbortController();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sibling = mock(() => {});
    bus.on('message', async () => {
      await blocked;
    });
    bus.on('message', sibling);
    const emission = bus.emit('message', 'hello', { signal: controller.signal });
    controller.abort();
    release();
    await emission;
    expect(sibling).not.toHaveBeenCalled();
    await bus.emit('message', 'hello', { signal: controller.signal });
    expect(sibling).not.toHaveBeenCalled();
  });
  it.each([
    { throwOnError: false, failFast: false },
    { throwOnError: true, failFast: false },
    { throwOnError: true, failFast: true },
  ])('preserves running listener failures after abort (%j)', async (options) => {
    const onError = mock<NonNullable<EventBusOptions<Events>['onError']>>(() => {});
    const bus = new EventBus<Events>({ onError });
    const controller = new AbortController();
    const gate = Promise.withResolvers<void>();
    const failure = new Error('listener failed after cancellation');
    const sibling = mock(() => {});
    bus.on('message', async () => {
      await gate.promise;
      throw failure;
    });
    bus.on('message', sibling);
    const result = bus
      .emit('message', 'hello', { ...options, signal: controller.signal })
      .catch((error: unknown) => error);
    controller.abort();
    gate.resolve();
    const error = await result;
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ event: 'message', payload: 'hello', error: failure });
    expect(sibling).not.toHaveBeenCalled();
    if (!options.throwOnError) expect(error).toBeUndefined();
    else if (options.failFast) expect(error).toBe(failure);
    else {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([failure]);
    }
  });

  it('retains earlier collected failures when a later listener aborts delivery', async () => {
    const bus = new EventBus<Events>({ throwOnError: true });
    const controller = new AbortController();
    const failure = new Error('earlier listener');
    const sibling = mock(() => {});
    bus.on('message', () => {
      throw failure;
    });
    bus.on('message', () => {
      controller.abort();
    });
    bus.on('message', sibling);
    const error = await bus
      .emit('message', 'hello', { signal: controller.signal })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([failure]);
    expect(sibling).not.toHaveBeenCalled();
  });
});
