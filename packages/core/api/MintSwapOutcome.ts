import type { EventBus } from '../events/EventBus.ts';
import type { CoreEvents } from '../events/types.ts';
import type { MintSwapOperation } from '../operations/mintSwap/MintSwapOperation.ts';

type OutcomeState = 'completed' | 'cancelled' | 'failed' | 'needs_attention';
type SettledOutcome = {
  [State in OutcomeState]: {
    status: State;
    operation: Extract<MintSwapOperation, { state: State }>;
  };
}[OutcomeState];

/** Attention is unresolved value; timeout changes no persisted state. */
export type MintSwapOutcome =
  | SettledOutcome
  | { status: 'timeout'; operation: Exclude<MintSwapOperation, { state: OutcomeState }> };

export interface MintSwapWaitOptions {
  signal?: AbortSignal;
  /** Local observation deadline in milliseconds. Omit to wait until outcome/abort/disposal. */
  timeoutMs?: number;
  /** Local read fallback even if every event is lost. Default: 1000 ms. */
  pollIntervalMs?: number;
}

function outcome(operation: MintSwapOperation): SettledOutcome | undefined {
  switch (operation.state) {
    case 'completed':
      return { status: 'completed', operation };
    case 'cancelled':
      return { status: 'cancelled', operation };
    case 'failed':
      return { status: 'failed', operation };
    case 'needs_attention':
      return { status: 'needs_attention', operation };
  }
}

/** Local observation only; neither events nor the deadline authorize recovery. */
export function waitForMintSwapOutcome(
  id: string,
  get: (id: string) => Promise<MintSwapOperation | null>,
  events: EventBus<CoreEvents>,
  disposed: AbortSignal,
  options: MintSwapWaitOptions = {},
): Promise<MintSwapOutcome> {
  const interval = options.pollIntervalMs ?? 1000;
  if (!Number.isFinite(interval) || interval <= 0 || interval > 2_147_483_647)
    return Promise.reject(new TypeError('pollIntervalMs must be a positive timer interval'));
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  )
    return Promise.reject(new TypeError('timeoutMs must be finite and nonnegative'));
  if (disposed.aborted) return Promise.reject(disposed.reason);
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);

  return new Promise((resolve, reject) => {
    let done = false;
    let reading = false;
    let requested = false;
    let subscribed = false;
    let timedOut = options.timeoutMs === 0;
    let latest: MintSwapOperation | undefined;
    let unsubscribe: (() => void) | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    const cleanup = () => {
      done = true;
      unsubscribe?.();
      clearInterval(poll);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      disposed.removeEventListener('abort', dispose);
    };
    const fail = (error: unknown) => {
      if (done) return;
      cleanup();
      reject(error);
    };
    const abort = () => fail(options.signal?.reason);
    const dispose = () => fail(disposed.reason);
    const finish = (value: MintSwapOutcome) => {
      if (done) return;
      cleanup();
      resolve(value);
    };
    const read = async () => {
      if (done) return;
      requested = true;
      if (reading) return;
      reading = true;
      try {
        while (requested && !done) {
          requested = false;
          // A timeout that arrives during a read requests a further authoritative final read.
          const finalRead = timedOut;
          const current = await get(id);
          if (done) return;
          if (!current) throw new Error('Mint Swap was not found');
          if (!latest || current.revision >= latest.revision) latest = current;
          const result = outcome(latest);
          if (result) {
            finish(result);
            return;
          }
          if (finalRead) {
            finish({
              status: 'timeout',
              operation: latest as Exclude<MintSwapOperation, { state: OutcomeState }>,
            });
            return;
          }
          if (!subscribed) {
            subscribed = true;
            unsubscribe = events.on('mint-swap:updated', (event) => {
              if (event.operationId === id) void read();
            });
            requested = true; // read-subscribe-read closes the subscription gap.
          }
        }
      } catch (error) {
        fail(error);
      } finally {
        reading = false;
      }
    };
    const deadline = () => {
      if (done || options.timeoutMs === undefined) return;
      const remaining = options.timeoutMs - (performance.now() - started);
      if (remaining > 0) {
        timer = setTimeout(deadline, Math.min(remaining, 2_147_483_647));
      } else {
        timedOut = true;
        void read();
      }
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    disposed.addEventListener('abort', dispose, { once: true });
    poll = setInterval(() => {
      void read();
    }, interval);
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) deadline();
    void read();
  });
}
