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

  it('uses the listener snapshot when listeners are added or removed during dispatch', async () => {
    const bus = new EventBus<Events>();
    const calls: string[] = [];
    const added = () => {
      calls.push('added');
    };
    bus.once('message', () => {
      removeSibling();
      bus.on('message', added);
    });
    const removeSibling = bus.on('message', () => {
      calls.push('sibling');
    });

    await bus.emit('message', 'hello');
    expect(calls).toEqual(['sibling']);
    await bus.emit('message', 'hello');
    expect(calls).toEqual(['sibling', 'added']);
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

  it.each([false, true])(
    'honors per-emit throwOnError: %s over the bus default',
    async (throwOnError) => {
      const bus = new EventBus<Events>({ throwOnError: !throwOnError });
      bus.on('message', () => {
        throw new Error('listener');
      });

      const emitted = bus.emit('message', 'hello', { throwOnError });
      if (throwOnError) {
        await expect(emitted).rejects.toBeInstanceOf(AggregateError);
      } else {
        await expect(emitted).resolves.toBeUndefined();
      }
    },
  );

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

  it('continues delivery with failFast when throwOnError is disabled', async () => {
    const bus = new EventBus<Events>();
    const sibling = mock(() => {});
    bus.on('message', () => {
      throw new Error('listener');
    });
    bus.on('message', sibling);

    await bus.emit('message', 'hello', { failFast: true });
    expect(sibling).toHaveBeenCalledTimes(1);
  });
});
