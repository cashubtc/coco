import type { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { MintSwapOperationRepository } from '../../operations/mintSwap/MintSwapOperationRepository.ts';
import type { MintSwapOperationService } from '../../operations/mintSwap/MintSwapOperationService.ts';
import { isMintSwapAutomaticState } from '../../operations/mintSwap/MintSwapOperation.ts';

export interface MintSwapOperationProcessorOptions {
  /** Due scan cadence. Default: 1000 ms. Does not replace persisted retry policy. */
  processIntervalMs?: number;
  /** Complete active sweep cadence, including prepared parents. Default: 30000 ms. */
  sweepIntervalMs?: number;
  /** Attempts between yields; full sweeps always visit the complete eligible snapshot. */
  batchSize?: number;
}

export function validateMintSwapProcessorOptions(options: MintSwapOperationProcessorOptions): void {
  for (const value of [options.processIntervalMs, options.sweepIntervalMs]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647))
      throw new TypeError('Mint Swap processor intervals must be positive timer intervals');
  }
  if (
    options.batchSize !== undefined &&
    (!Number.isSafeInteger(options.batchSize) || options.batchSize <= 0)
  )
    throw new TypeError('Mint Swap batchSize must be a positive integer');
}

/** Session-owned scheduling only. Persisted coordinator state owns all economic retries. */
export class MintSwapOperationProcessor {
  private readonly interval: number;
  private readonly sweepInterval: number;
  private readonly batchSize: number;
  private running = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private worker?: Promise<void>;
  private stopping?: Promise<void>;
  private unsubscribe: Array<() => void> = [];
  private sweepRequested = false;
  private lastSweep = 0;

  constructor(
    private readonly service: Pick<MintSwapOperationService, 'reconcileInBackground'>,
    private readonly queries: Pick<MintSwapOperationRepository, 'listActive' | 'listDue'>,
    private readonly events: EventBus<CoreEvents>,
    private readonly logger?: Logger,
    options: MintSwapOperationProcessorOptions = {},
  ) {
    validateMintSwapProcessorOptions(options);
    this.interval = options.processIntervalMs ?? 1000;
    this.sweepInterval = options.sweepIntervalMs ?? 30_000;
    this.batchSize = options.batchSize ?? 25;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    // A stop wins overlapping starts; a later explicit start can begin a new generation.
    if (this.stopping) {
      await this.stopping;
      return;
    }
    if (this.running) {
      await this.worker;
      return;
    }
    this.running = true;
    const generation = ++this.generation;
    const wake = () => {
      if (this.active(generation)) this.sweepRequested = true;
    };
    // Callbacks return promptly even when publication still holds a generic child lock.
    for (const event of [
      'mint-swap:updated',
      'mint-op:pending',
      'mint-op:executing',
      'mint-op:finalized',
      'mint-op:failed',
      'melt-op:pending',
      'melt-op:finalized',
      'melt-op:rolled-back',
      'mint-quote:updated',
      'melt-quote:updated',
    ] as const)
      this.unsubscribe.push(this.events.on(event, wake));
    this.sweepRequested = true;
    await this.run(generation);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    ++this.generation;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.sweepRequested = false;
    const stopping = Promise.resolve(this.worker).then(() => {});
    this.stopping = stopping;
    void stopping.then(() => {
      if (this.stopping === stopping) this.stopping = undefined;
    });
    return stopping;
  }

  private active(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private async run(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    const work = this.scan(generation);
    this.worker = work;
    try {
      await work;
    } finally {
      if (this.worker === work) this.worker = undefined;
      if (this.active(generation)) {
        // Even self-generated hints wait for the cadence and recheck durable due times.
        this.timer = setTimeout(() => {
          void this.run(generation);
        }, this.interval);
      }
    }
  }

  private async scan(generation: number): Promise<void> {
    try {
      const now = Date.now();
      const full = this.sweepRequested || performance.now() - this.lastSweep >= this.sweepInterval;
      this.sweepRequested = false;
      // A failed active enumeration must not prevent the next ordinary due scan.
      if (full) this.lastSweep = performance.now();
      const candidates = full
        ? (await this.queries.listActive()).filter(
            (parent) =>
              parent.state === 'prepared' ||
              (isMintSwapAutomaticState(parent.state) &&
                parent.retry.nextAttemptAt !== null &&
                parent.retry.nextAttemptAt <= now),
          )
        : await this.queries.listDue(now, this.batchSize);
      if (full) {
        candidates.sort(
          (a, b) =>
            (a.retry.nextAttemptAt ?? Infinity) - (b.retry.nextAttemptAt ?? Infinity) ||
            a.createdAt - b.createdAt ||
            a.id.localeCompare(b.id),
        );
      }
      for (let index = 0; index < candidates.length; index++) {
        if (!this.active(generation)) return;
        try {
          await this.service.reconcileInBackground(candidates[index]!.id);
        } catch {
          this.logger?.warn('Mint Swap background reconciliation failed');
        }
        if ((index + 1) % this.batchSize === 0 && index + 1 < candidates.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    } catch {
      // Later scans retry discovery without changing parent evidence.
      this.logger?.warn('Mint Swap background scan failed');
    }
  }
}
