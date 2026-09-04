import { describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';
import { BackgroundTaskRuntime } from '../../services/watchers/BackgroundTaskRuntime.ts';

describe('BackgroundTaskRuntime', () => {
  it('deduplicates keyed tasks until the active task completes', async () => {
    const runtime = BackgroundTaskRuntime.make();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = mock(async () => {
      await gate;
    });
    const task = Effect.promise(run);

    expect(runtime.runKeyed('operation-1', task)).toBe(true);
    expect(runtime.runKeyed('operation-1', task)).toBe(false);
    expect(runtime.keyedTaskCount).toBe(1);

    release();
    await runtime.waitForIdle();

    expect(run).toHaveBeenCalledTimes(1);
    expect(runtime.runKeyed('operation-1', Effect.void)).toBe(true);
    await runtime.waitForIdle();
    await runtime.close();
  });

  it('cancels selected keyed tasks', async () => {
    const runtime = BackgroundTaskRuntime.make();

    runtime.runKeyed('mint-a:1', Effect.never);
    runtime.runKeyed('mint-a:2', Effect.never);
    runtime.runKeyed('mint-b:1', Effect.never);

    expect(await runtime.cancelWhere((key) => key.startsWith('mint-a:'))).toBe(2);
    expect(runtime.keyedTaskCount).toBe(1);

    await runtime.close();
  });

  it('runs finalizers once and waits for uninterruptible tasks while closing', async () => {
    const runtime = BackgroundTaskRuntime.make();
    const finalize = mock(async () => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closed = false;

    runtime.addFinalizer(finalize);
    void runtime.run(Effect.promise(() => gate).pipe(Effect.uninterruptible));

    const closing = runtime.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    release();
    await closing;
    await runtime.close();

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(runtime.isActive).toBe(false);
  });
});
