import { Effect, Exit, Fiber, FiberMap, FiberSet, Scope } from 'effect';

type BackgroundTask = Effect.Effect<void, never>;
type ScopedResource<A> = Effect.Effect<A, never, Scope.Scope>;
type Finalizer = () => void | Promise<void>;

/**
 * Owns the Effect scope and fibers used by a start/stop background service.
 * Domain services keep their own state; this runtime only manages task lifetime.
 */
export class BackgroundTaskRuntime {
  private active = true;
  private closePromise?: Promise<void>;

  private constructor(
    private readonly scope: Scope.CloseableScope,
    private readonly keyedTasks: FiberMap.FiberMap<string, void, never>,
    private readonly tasks: FiberSet.FiberSet<void, never>,
  ) {}

  static make(): BackgroundTaskRuntime {
    const scope = Effect.runSync(Scope.make());
    const { keyedTasks, tasks } = Effect.runSync(
      Effect.gen(function* () {
        return {
          keyedTasks: yield* FiberMap.make<string, void, never>(),
          tasks: yield* FiberSet.make<void, never>(),
        };
      }).pipe(Scope.extend(scope)),
    );

    return new BackgroundTaskRuntime(scope, keyedTasks, tasks);
  }

  get isActive(): boolean {
    return this.active;
  }

  get keyedTaskCount(): number {
    return Array.from(this.keyedTasks).length;
  }

  /** Acquire an Effect resource whose finalizer should share this runtime's lifetime. */
  acquire<A>(resource: ScopedResource<A>): A {
    if (!this.active) {
      throw new Error('Cannot acquire a resource from a closed background task runtime');
    }
    return Effect.runSync(resource.pipe(Scope.extend(this.scope)));
  }

  addFinalizer(finalizer: Finalizer): void {
    if (!this.active) {
      throw new Error('Cannot add a finalizer to a closed background task runtime');
    }

    Effect.runSync(
      Scope.addFinalizer(
        this.scope,
        Effect.promise(async () => {
          await finalizer();
        }),
      ),
    );
  }

  /** Track a task and return a promise that settles when its fiber exits. */
  async run(task: BackgroundTask): Promise<void> {
    if (!this.active) return;

    const fiber = Effect.runSync(FiberSet.run(this.tasks, task));
    await Effect.runPromise(Fiber.await(fiber));
  }

  /** Start a keyed task unless that key is already active. */
  runKeyed(key: string, task: BackgroundTask): boolean {
    if (!this.active || FiberMap.unsafeHas(this.keyedTasks, key)) return false;

    Effect.runSync(FiberMap.run(this.keyedTasks, key, task, { onlyIfMissing: true }));
    return true;
  }

  async cancelWhere(predicate: (key: string) => boolean): Promise<number> {
    const keys = Array.from(this.keyedTasks, ([key]) => key).filter(predicate);
    await Effect.runPromise(
      Effect.forEach(keys, (key) => FiberMap.remove(this.keyedTasks, key), { discard: true }),
    );
    return keys.length;
  }

  async waitForIdle(): Promise<void> {
    while (true) {
      await Effect.runPromise(
        Effect.all([FiberMap.awaitEmpty(this.keyedTasks), FiberSet.awaitEmpty(this.tasks)], {
          concurrency: 'unbounded',
        }),
      );

      if (this.keyedTaskCount === 0 && Array.from(this.tasks).length === 0) return;
      await Effect.runPromise(Effect.yieldNow());
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.active = false;
    this.closePromise = Effect.runPromise(Scope.close(this.scope, Exit.void));
    return this.closePromise;
  }
}

/** Bridge an existing Promise without abandoning it during graceful shutdown. */
export function uninterruptiblePromise<A>(evaluate: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (error) => error,
  }).pipe(Effect.uninterruptible);
}
