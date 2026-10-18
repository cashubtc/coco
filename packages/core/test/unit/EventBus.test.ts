import { describe, expect, it, mock } from 'bun:test';
import { EventBus, type EventBusOptions } from '../../events/EventBus.ts';

type Events = { message: string };

describe('EventBus', () => {
  it('skips delivery when the publication is already aborted', async () => {
    const bus = new EventBus<Events>();
    const controller = new AbortController();
    const listener = mock(() => {});
    bus.on('message', listener);
    controller.abort();

    await bus.emit('message', 'hello', { signal: controller.signal });
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops waiting for an active listener and skips later listeners on abort', async () => {
    const bus = new EventBus<Events>();
    const controller = new AbortController();
    const gate = Promise.withResolvers<void>();
    const later = mock(() => {});
    const off = bus.on('message', () => gate.promise);
    bus.on('message', later);

    const emitted = bus.emit('message', 'hello', { signal: controller.signal });
    controller.abort();
    await emitted;
    // A rejected listener after cancellation must remain observed, not become unhandled.
    gate.reject(new Error('listener failed after cancellation'));
    await Promise.resolve();
    expect(later).not.toHaveBeenCalled();

    off();
    await bus.emit('message', 'next');
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('allows a listener to abort publication and await that same publication', async () => {
    const bus = new EventBus<Events>();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    let emitted!: Promise<void>;
    bus.on('message', async () => {
      await entered.promise;
      controller.abort();
      await emitted;
      completed.resolve();
    });
    emitted = bus.emit('message', 'hello', { signal: controller.signal });
    entered.resolve();
    await emitted;
    await completed.promise;
  });

  it('can abort while waiting for an asynchronous error handler', async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const bus = new EventBus<Events>({
      onError: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    bus.on('message', () => {
      throw new Error('listener failed');
    });
    const later = mock(() => {});
    bus.on('message', later);
    const emitted = bus.emit('message', 'hello', { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await emitted;
    gate.resolve();
    expect(later).not.toHaveBeenCalled();
  });

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
});
