import { Effect, Exit, FiberMap, FiberSet, RateLimiter, Schedule, Scope } from 'effect';
import type { EventBus, CoreEvents } from '@core/events';
import type { MintMethod, MintOperationService } from '@core/operations/mint';
import type { Logger } from '../../logging/Logger.ts';
import { MintOperationError, NetworkError } from '../../models/Error';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';

interface QueueItem {
  mintUrl: string;
  operationId: string;
  method: string;
}

interface OperationHandler {
  process(mintUrl: string, operationId: string): Promise<void>;
}

interface ProcessorRuntime {
  readonly scope: Scope.CloseableScope;
  readonly operationFibers: FiberMap.FiberMap<string, void, never>;
  readonly claimFibers: FiberSet.FiberSet<void, never>;
  readonly operationSemaphore: Effect.Semaphore;
  readonly rateLimitOperation: RateLimiter.RateLimiter;
}

class DefaultMintOperationHandler implements OperationHandler {
  constructor(private mintOperations: MintOperationService) {}

  async process(_mintUrl: string, operationId: string): Promise<void> {
    await this.mintOperations.finalize(operationId);
  }
}

export interface MintOperationProcessorOptions {
  processIntervalMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  initialEnqueueDelayMs?: number;
  autoClaimMintQuotes?: boolean;
}

function operationKey(mintUrl: string, operationId: string): string {
  return JSON.stringify([mintUrl, operationId]);
}

function mintUrlFromOperationKey(key: string): string | undefined {
  try {
    const parsed = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
}

function quoteKey(mintUrl: string, method: MintMethod, quoteId: string): string {
  return JSON.stringify([mintUrl, method, quoteId]);
}

function isNetworkError(error: unknown): boolean {
  return (
    error instanceof NetworkError || (error instanceof Error && error.message.includes('network'))
  );
}

function waitForPromise<A>(evaluate: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (error) => error,
  }).pipe(Effect.uninterruptible);
}

export class MintOperationProcessor {
  private readonly mintOperations: MintOperationService;
  private readonly quoteLifecycle: QuoteLifecycle;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  private running = false;
  private runtime?: ProcessorRuntime;
  private readonly claimingQuotes = new Set<string>();
  private readonly quoteClaimsNeedingFollowUp = new Set<string>();
  private readonly handlers = new Map<string, OperationHandler>();
  private readonly processIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly initialEnqueueDelayMs: number;
  private readonly autoClaimMintQuotes: boolean;

  constructor(
    mintOperations: MintOperationService,
    quoteLifecycle: QuoteLifecycle,
    bus: EventBus<CoreEvents>,
    logger?: Logger,
    options?: MintOperationProcessorOptions,
  ) {
    this.mintOperations = mintOperations;
    this.quoteLifecycle = quoteLifecycle;
    this.bus = bus;
    this.logger = logger;
    this.processIntervalMs = options?.processIntervalMs ?? 3000;
    this.maxRetries = options?.maxRetries ?? 3;
    this.baseRetryDelayMs = options?.baseRetryDelayMs ?? 5000;
    this.initialEnqueueDelayMs = options?.initialEnqueueDelayMs ?? 500;
    this.autoClaimMintQuotes = options?.autoClaimMintQuotes ?? true;

    const defaultHandler = new DefaultMintOperationHandler(mintOperations);
    for (const method of ['bolt11', 'bolt12', 'onchain']) {
      this.registerHandler(method, defaultHandler);
    }
  }

  registerHandler(method: string, handler: OperationHandler): void {
    this.handlers.set(method, handler);
    this.logger?.debug('Registered mint operation handler', { method });
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const scope = Effect.runSync(Scope.make());
    try {
      const runtime = Effect.runSync(
        Effect.gen(this, function* () {
          const operationFibers = yield* FiberMap.make<string, void, never>();
          const claimFibers = yield* FiberSet.make<void, never>();
          const operationSemaphore = yield* Effect.makeSemaphore(1);
          const rateLimitOperation = yield* RateLimiter.make({
            limit: 1,
            interval: Math.max(1, this.processIntervalMs),
          });

          return {
            scope,
            operationFibers,
            claimFibers,
            operationSemaphore,
            rateLimitOperation,
          } satisfies ProcessorRuntime;
        }).pipe(Scope.extend(scope)),
      );

      this.runtime = runtime;
      const unsubscribe = this.subscribeToEvents(runtime);
      Effect.runSync(Scope.addFinalizer(scope, Effect.sync(unsubscribe)));

      if (this.autoClaimMintQuotes) {
        this.schedulePendingQuoteClaims(runtime);
      }

      this.logger?.info('MintOperationProcessor started');
    } catch (error) {
      this.runtime = undefined;
      this.running = false;
      await Effect.runPromise(Scope.close(scope, Exit.fail(error)));
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    const runtime = this.runtime;
    this.runtime = undefined;
    const pendingItems = runtime ? Array.from(runtime.operationFibers).length : 0;

    if (runtime) {
      await Effect.runPromise(Scope.close(runtime.scope, Exit.void));
    }

    this.claimingQuotes.clear();
    this.quoteClaimsNeedingFollowUp.clear();
    this.logger?.info('MintOperationProcessor stopped', { pendingItems });
  }

  /**
   * Wait for all scheduled operations and quote claims to complete.
   * Useful for CLI applications that want to drain processor work before exiting.
   */
  async waitForCompletion(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;

    while (this.runtime === runtime) {
      await Effect.runPromise(
        Effect.all(
          [FiberMap.awaitEmpty(runtime.operationFibers), FiberSet.awaitEmpty(runtime.claimFibers)],
          { concurrency: 'unbounded' },
        ),
      );

      if (
        this.runtime !== runtime ||
        (Array.from(runtime.operationFibers).length === 0 &&
          Array.from(runtime.claimFibers).length === 0 &&
          this.claimingQuotes.size === 0)
      ) {
        return;
      }

      await Effect.runPromise(Effect.yieldNow());
    }
  }

  /**
   * Remove all scheduled work for a specific mint.
   * Called when a mint is untrusted to stop processing its operations.
   */
  clearMintFromQueue(mintUrl: string): void {
    const runtime = this.runtime;
    if (!runtime) return;

    const keys = Array.from(runtime.operationFibers, ([key]) => key).filter(
      (key) => mintUrlFromOperationKey(key) === mintUrl,
    );
    if (keys.length === 0) return;

    Effect.runFork(
      Effect.forEach(keys, (key) => FiberMap.remove(runtime.operationFibers, key), {
        discard: true,
      }),
    );
    this.logger?.info('Cleared mint operations from processor queue', {
      mintUrl,
      removed: keys.length,
    });
  }

  private subscribeToEvents(runtime: ProcessorRuntime): () => void {
    const unsubscribe = [
      this.bus.on('mint-quote:updated', ({ mintUrl, method, quoteId }) => {
        this.scheduleQuoteClaim(runtime, mintUrl, method, quoteId);
      }),
      this.bus.on('mint-op:pending', ({ operation }) => {
        if (operation.state !== 'pending') return;
        this.schedulePendingOperationClaim(runtime, operation);
      }),
      this.bus.on('mint-op:requeue', ({ mintUrl, operationId, operation }) => {
        this.enqueue(runtime, mintUrl, operationId, operation.method);
      }),
      this.bus.on('mint:untrusted', ({ mintUrl }) => {
        this.clearMintFromQueue(mintUrl);
      }),
    ];

    return () => {
      for (const off of unsubscribe) {
        try {
          off();
        } catch {
          // Event cleanup is best effort; the Effect scope still owns all scheduled work.
        }
      }
    };
  }

  private enqueue(
    runtime: ProcessorRuntime,
    mintUrl: string,
    operationId: string,
    method: string,
  ): void {
    if (this.runtime !== runtime) return;

    const key = operationKey(mintUrl, operationId);
    if (FiberMap.unsafeHas(runtime.operationFibers, key)) {
      this.logger?.debug('Mint operation already scheduled', { mintUrl, operationId });
      return;
    }

    const item = { mintUrl, operationId, method } satisfies QueueItem;
    Effect.runSync(
      FiberMap.run(runtime.operationFibers, key, this.processOperation(runtime, item), {
        onlyIfMissing: true,
      }),
    );

    this.logger?.debug('Mint operation scheduled for processing', {
      mintUrl,
      operationId,
      method,
      queueLength: Array.from(runtime.operationFibers).length,
    });
  }

  private scheduleQuoteClaim(
    runtime: ProcessorRuntime,
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
  ): void {
    if (!this.autoClaimMintQuotes || this.runtime !== runtime) return;

    const key = quoteKey(mintUrl, method, quoteId);
    if (this.claimingQuotes.has(key)) {
      this.quoteClaimsNeedingFollowUp.add(key);
      this.logger?.debug('Mint quote claim already in progress', { mintUrl, method, quoteId });
      return;
    }

    this.claimingQuotes.add(key);
    const claim = this.claimMintQuote(mintUrl, method, quoteId).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          this.logger?.warn('Failed to check or claim mint quote', {
            mintUrl,
            method,
            quoteId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          this.claimingQuotes.delete(key);
          const needsFollowUp = this.quoteClaimsNeedingFollowUp.delete(key);
          if (needsFollowUp && this.runtime === runtime) {
            this.scheduleQuoteClaim(runtime, mintUrl, method, quoteId);
          }
        }),
      ),
    );

    Effect.runSync(FiberSet.run(runtime.claimFibers, claim));
  }

  private claimMintQuote(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      const assessment = yield* waitForPromise(() =>
        this.mintOperations.getMintQuoteClaimability(mintUrl, method, quoteId),
      );
      if (assessment?.status !== 'claimable' && assessment?.status !== 'complete') {
        this.logger?.debug('Mint quote has no locally claimable value', {
          mintUrl,
          method,
          quoteId,
        });
        return;
      }

      yield* waitForPromise(() =>
        this.mintOperations.claimMintQuote(mintUrl, method, quoteId, {
          autoClaimRemaining: true,
        }),
      );
    });
  }

  private schedulePendingOperationClaim(
    runtime: ProcessorRuntime,
    operation: { mintUrl: string; method: MintMethod; quoteId: string },
  ): void {
    const task = waitForPromise(() =>
      this.quoteLifecycle.getMintQuote(operation.mintUrl, operation.method, operation.quoteId),
    ).pipe(
      Effect.tap((quote) =>
        Effect.sync(() => {
          if (quote) {
            this.scheduleQuoteClaim(
              runtime,
              operation.mintUrl,
              operation.method,
              operation.quoteId,
            );
          }
        }),
      ),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          this.logger?.warn('Failed to check mint quote for pending operation', {
            mintUrl: operation.mintUrl,
            method: operation.method,
            quoteId: operation.quoteId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
    );

    Effect.runSync(FiberSet.run(runtime.claimFibers, task));
  }

  private schedulePendingQuoteClaims(runtime: ProcessorRuntime): void {
    const task = waitForPromise(() =>
      this.mintOperations.claimPendingMintQuotes({ autoClaimRemaining: true }),
    ).pipe(
      Effect.asVoid,
      Effect.catchAll((error) =>
        Effect.sync(() => {
          this.logger?.warn('Failed to claim pending mint quotes on startup', {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
    );

    Effect.runSync(FiberSet.run(runtime.claimFibers, task));
  }

  private processOperation(runtime: ProcessorRuntime, item: QueueItem): Effect.Effect<void, never> {
    let attemptNumber = 0;
    const retrySchedule = Schedule.exponential(Math.max(1, this.baseRetryDelayMs)).pipe(
      Schedule.intersect(Schedule.recurs(this.maxRetries)),
      Schedule.tapInput((error) =>
        Effect.sync(() => {
          if (!isNetworkError(error) || attemptNumber > this.maxRetries) return;
          const retryInMs = this.baseRetryDelayMs * Math.pow(2, attemptNumber - 1);
          this.logger?.warn('Network error, will retry', {
            mintUrl: item.mintUrl,
            operationId: item.operationId,
            attempt: attemptNumber,
            maxRetries: this.maxRetries,
            retryInMs,
          });
        }),
      ),
    );

    const attempt = Effect.suspend(() => {
      const { mintUrl, operationId, method } = item;
      const handler = this.handlers.get(method);
      if (!handler) {
        this.logger?.warn('No handler registered for mint method', {
          method,
          mintUrl,
          operationId,
        });
        return Effect.void;
      }

      attemptNumber++;
      this.logger?.info('Processing mint operation', {
        mintUrl,
        operationId,
        method,
        attempt: attemptNumber,
      });

      return waitForPromise(() => handler.process(mintUrl, operationId)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.logger?.info('Successfully processed mint operation', {
              mintUrl,
              operationId,
              method,
            });
          }),
        ),
      );
    });

    const serializedAttempt = runtime.operationSemaphore.withPermits(1)(
      runtime.rateLimitOperation(attempt),
    );

    return Effect.sleep(Math.max(0, this.initialEnqueueDelayMs)).pipe(
      Effect.andThen(
        Effect.retry(serializedAttempt, {
          while: isNetworkError,
          schedule: retrySchedule,
        }),
      ),
      Effect.catchAll((error) => this.logTerminalProcessingError(item, error)),
    );
  }

  private logTerminalProcessingError(item: QueueItem, error: unknown): Effect.Effect<void> {
    return Effect.sync(() => {
      const { mintUrl, operationId } = item;
      if (error instanceof MintOperationError) {
        if (error.code === 20002) {
          this.logger?.info('Mint operation quote already issued', { mintUrl, operationId });
          return;
        }

        this.logger?.error('Mint operation error, not retrying', {
          mintUrl,
          operationId,
          code: error.code,
          detail: error.message,
        });
        return;
      }

      if (isNetworkError(error)) {
        this.logger?.error('Max retries exceeded for network error', {
          mintUrl,
          operationId,
          maxRetries: this.maxRetries,
        });
        return;
      }

      this.logger?.error('Failed to process mint operation', {
        mintUrl,
        operationId,
        err: error,
      });
    });
  }
}
