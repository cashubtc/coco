import { describe, expect, it } from 'bun:test';

import { EventBus } from '../../events/EventBus.ts';

type Events = { x: string };

describe('EventBus', () => {
  describe('parallel dispatch', () => {
    it('invokes every handler even when an earlier one throws synchronously', async () => {
      const calls: string[] = [];
      const bus = new EventBus<Events>({ concurrency: 'parallel' });
      bus.on('x', () => {
        throw new Error('sync boom');
      });
      bus.on('x', () => {
        calls.push('sibling');
      });

      await bus.emit('x', 'payload');

      expect(calls).toEqual(['sibling']);
    });

    it('delivers to all handlers when none fail', async () => {
      const calls: string[] = [];
      const bus = new EventBus<Events>({ concurrency: 'parallel' });
      bus.on('x', () => {
        calls.push('a');
      });
      bus.on('x', async () => {
        calls.push('b');
      });
      bus.on('x', () => {
        calls.push('c');
      });

      await bus.emit('x', 'payload');

      expect(calls.sort()).toEqual(['a', 'b', 'c']);
    });

    it('calls onError once per failed handler for sync, async, and mixed failures', async () => {
      const errors: Array<{ event: keyof Events; payload: Events[keyof Events]; error: unknown }> = [];
      const bus = new EventBus<Events>({
        concurrency: 'parallel',
        onError: ({ event, payload, error }) => {
          errors.push({ event, payload, error });
        },
      });
      bus.on('x', () => {
        throw new Error('sync');
      });
      bus.on('x', async () => {
        throw new Error('async');
      });
      bus.on('x', () => {});

      await bus.emit('x', 'payload');

      expect(errors).toHaveLength(2);
      expect(errors.map((e) => (e.error as Error).message).sort()).toEqual(['async', 'sync']);
      expect(errors.every((e) => e.event === 'x' && e.payload === 'payload')).toBe(true);
    });

    it('resolves without throwing by default when handlers fail', async () => {
      const bus = new EventBus<Events>({ concurrency: 'parallel' });
      bus.on('x', () => {
        throw new Error('sync');
      });

      await expect(bus.emit('x', 'payload')).resolves.toBeUndefined();
    });

    it('rejects with a single AggregateError containing all errors when throwOnError is true, after all siblings finish', async () => {
      const calls: string[] = [];
      const bus = new EventBus<Events>({ concurrency: 'parallel', throwOnError: true });
      bus.on('x', () => {
        throw new Error('sync');
      });
      bus.on('x', () => {
        calls.push('sibling');
      });
      bus.on('x', async () => {
        throw new Error('async');
      });

      let caught: unknown;
      try {
        await bus.emit('x', 'payload');
      } catch (error) {
        caught = error;
      }

      expect(calls).toEqual(['sibling']);
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toHaveLength(2);
    });

    it('lets an explicit per-emit throwOnError: false override a bus-level throwOnError: true', async () => {
      const bus = new EventBus<Events>({ concurrency: 'parallel', throwOnError: true });
      bus.on('x', () => {
        throw new Error('sync');
      });

      await expect(bus.emit('x', 'payload', { throwOnError: false })).resolves.toBeUndefined();
    });

    it('lets an explicit per-emit throwOnError: true override a bus-level default of false', async () => {
      const bus = new EventBus<Events>({ concurrency: 'parallel' });
      bus.on('x', () => {
        throw new Error('sync');
      });

      await expect(bus.emit('x', 'payload', { throwOnError: true })).rejects.toBeInstanceOf(
        AggregateError,
      );
    });
  });

  describe('sequential dispatch (default)', () => {
    it('continues to sibling handlers after a throwing handler by default', async () => {
      const calls: string[] = [];
      const bus = new EventBus<Events>();
      bus.on('x', () => {
        throw new Error('boom');
      });
      bus.on('x', () => {
        calls.push('sibling');
      });

      await bus.emit('x', 'payload');

      expect(calls).toEqual(['sibling']);
    });

    it('stops immediately on the first error when failFast is set with throwOnError', async () => {
      const calls: string[] = [];
      const bus = new EventBus<Events>({ throwOnError: true });
      bus.on('x', () => {
        throw new Error('boom');
      });
      bus.on('x', () => {
        calls.push('sibling');
      });

      await expect(bus.emit('x', 'payload', { failFast: true })).rejects.toThrow('boom');
      expect(calls).toEqual([]);
    });

    it('collects all errors into an AggregateError when throwOnError is true without failFast', async () => {
      const bus = new EventBus<Events>({ throwOnError: true });
      bus.on('x', () => {
        throw new Error('first');
      });
      bus.on('x', () => {
        throw new Error('second');
      });

      let caught: unknown;
      try {
        await bus.emit('x', 'payload');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toHaveLength(2);
    });
  });
});
