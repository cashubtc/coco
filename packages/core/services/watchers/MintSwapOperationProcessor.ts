import type { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { MintSwapOperationRepository } from '../../operations/mintSwap/MintSwapOperationRepository.ts';
import type { MintSwapOperationService } from '../../operations/mintSwap/MintSwapOperationService.ts';
import type { MintSwapOperation } from '../../operations/mintSwap/MintSwapOperation.ts';
import type { MeltOperation } from '../../operations/melt/MeltOperation.ts';
import type { MintOperation } from '../../operations/mint/MintOperation.ts';
import {
  quoteWatchKey,
  type QuoteInterestRegistrar,
  type QuoteWatchInterest,
  type QuoteWatchOwner,
} from './QuoteWatchInterests.ts';
import { isMintSwapAutomaticState } from '../../operations/mintSwap/MintSwapOperation.ts';

interface ObservationDependencies {
  readonly mint?: QuoteInterestRegistrar;
  readonly melt?: QuoteInterestRegistrar;
  readonly source?: { getById(id: string): Promise<MeltOperation | null> };
  readonly destination?: { getById(id: string): Promise<MintOperation | null> };
}

type Registration = { registrar: QuoteInterestRegistrar; interest: QuoteWatchInterest };

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
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private worker?: Promise<void>;
  private stopping?: Promise<void>;
  private unsubscribe: Array<() => void> = [];
  private sweepRequested = false;
  private lastSweep = 0;
  private readonly parents = new Map<string, MintSwapOperation>();
  private readonly quoteParents = new Map<string, Set<string>>();
  private readonly childParents = new Map<string, string>();
  private readonly hinted = new Set<string>();
  private readonly registrations = new Map<string, Registration>();
  private readonly retiredInterests = new Set<Promise<void>>();

  constructor(
    private readonly service: Pick<MintSwapOperationService, 'reconcileInBackground'>,
    private readonly queries: Pick<MintSwapOperationRepository, 'listActive' | 'listDue'>,
    private readonly events: EventBus<CoreEvents>,
    private readonly logger?: Logger,
    options: MintSwapOperationProcessorOptions = {},
    private readonly observations: ObservationDependencies = {},
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
    if (this.started || this.stopping) return;
    this.started = true;
    this.running = true;
    const wake = () => {
      if (this.running) this.sweepRequested = true;
    };
    // Callbacks only schedule; none await subscriptions, transactions or child locks.
    this.unsubscribe.push(
      this.events.on('mint-swap:updated', ({ operationId }) => {
        if (this.running) {
          this.hinted.add(operationId);
          wake();
        }
      }),
    );
    for (const event of [
      'mint-op:pending',
      'mint-op:executing',
      'mint-op:finalized',
      'mint-op:failed',
      'melt-op:pending',
      'melt-op:finalized',
      'melt-op:rolled-back',
    ] as const) {
      this.unsubscribe.push(
        this.events.on(event, ({ operationId }) => {
          const parentId = this.childParents.get(operationId);
          if (this.running && parentId) {
            this.hinted.add(parentId);
            wake();
          }
        }),
      );
    }
    for (const kind of ['mint', 'melt'] as const) {
      this.unsubscribe.push(
        this.events.on(`${kind}-quote:updated`, ({ mintUrl, method, quoteId }) => {
          if (!this.running) return;
          for (const id of this.quoteParents.get(
            `${kind}:${quoteWatchKey({ mintUrl, method, quoteId })}`,
          ) ?? [])
            this.hinted.add(id);
        }),
      );
    }
    this.sweepRequested = true;
    await this.run(true);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.sweepRequested = false;
    const stopping = Promise.resolve(this.worker).then(async () => {
      for (const registration of this.registrations.values()) this.retireInterest(registration);
      this.registrations.clear();
      this.parents.clear();
      this.quoteParents.clear();
      this.childParents.clear();
      this.hinted.clear();
      while (this.retiredInterests.size) await Promise.all([...this.retiredInterests]);
    });
    this.stopping = stopping;
    return stopping;
  }

  private retireInterest(registration: Registration): void {
    // Watcher withdrawal is synchronous. Track only the physical cleanup it returns; a slow
    // retired acquisition must not block declarations or cached work for other parents.
    let removal: Promise<void>;
    try {
      removal = registration.registrar.removeInterest(registration.interest.owner);
    } catch (error) {
      removal = Promise.reject(error);
    }
    const cleanup = removal.catch((err) => {
      this.logger?.warn('Mint Swap quote interest cleanup failed', {
        operationId: registration.interest.owner.id,
        mintUrl: registration.interest.mintUrl,
        quoteId: registration.interest.quoteId,
        err,
      });
    });
    this.retiredInterests.add(cleanup);
    void cleanup.then(() => this.retiredInterests.delete(cleanup));
  }

  private async run(startup = false): Promise<void> {
    if (!this.running) return;
    const work = this.scan(startup);
    this.worker = work;
    try {
      await work;
    } finally {
      this.worker = undefined;
      if (this.running) {
        // Even self-generated hints wait for the cadence and recheck durable due times.
        this.timer = setTimeout(() => {
          void this.run();
        }, this.interval);
      }
    }
  }

  private async synchronizeInterests(parents: MintSwapOperation[]): Promise<void> {
    const desired = new Map<string, Registration>();
    const nextParents = new Map<string, MintSwapOperation>();
    const nextQuotes = new Map<string, Set<string>>();
    const nextChildren = new Map<string, string>();
    if (this.running) {
      for (const parent of parents) {
        if (parent.state === 'needs_attention') continue;
        nextParents.set(parent.id, parent);
        nextChildren.set(parent.sourceOperationId, parent.id);
        nextChildren.set(parent.destinationOperationId, parent.id);
        const source = await this.observations.source?.getById(parent.sourceOperationId);
        const destination = await this.observations.destination?.getById(
          parent.destinationOperationId,
        );
        if (!this.running) return;
        const recovery =
          parent.state === 'source_pending' ||
          parent.state === 'destination_funded' ||
          parent.state === 'destination_pending' ||
          ((source?.state === 'executing' ||
            source?.state === 'pending' ||
            source?.state === 'finalized') &&
            quoteWatchKey(source) === quoteWatchKey(parent.sourceQuote)) ||
          ((destination?.state === 'executing' || destination?.state === 'finalized') &&
            quoteWatchKey(destination) === quoteWatchKey(parent.destinationQuote));
        const owner: QuoteWatchOwner = { kind: 'mint-swap', id: parent.id, recovery };
        for (const kind of ['mint', 'melt'] as const) {
          if (
            kind === 'melt' &&
            (parent.state === 'destination_funded' || parent.state === 'destination_pending')
          )
            continue;
          const quote = kind === 'mint' ? parent.destinationQuote : parent.sourceQuote;
          const key = `${kind}:${quoteWatchKey(quote)}`;
          let ids = nextQuotes.get(key);
          if (!ids) nextQuotes.set(key, (ids = new Set()));
          ids.add(parent.id);
          const registrar = this.observations[kind];
          if (registrar)
            desired.set(`${kind}:${parent.id}`, { registrar, interest: { ...quote, owner } });
        }
      }
    }
    // Publish routing only after the complete durable snapshot has been read.
    this.parents.clear();
    this.quoteParents.clear();
    this.childParents.clear();
    for (const [key, value] of nextParents) this.parents.set(key, value);
    for (const [key, value] of nextQuotes) this.quoteParents.set(key, value);
    for (const [key, value] of nextChildren) this.childParents.set(key, value);
    for (const [key, previous] of this.registrations) {
      const next = desired.get(key);
      if (!next || quoteWatchKey(next.interest) !== quoteWatchKey(previous.interest)) {
        this.retireInterest(previous);
        this.registrations.delete(key);
      }
    }
    for (const [key, registration] of desired) {
      if (!this.running) return;
      // Declaration accepts local ownership immediately; activation and its diagnostics belong
      // to the watcher. Keep ownership until explicitly withdrawn, even when activation fails.
      this.registrations.set(key, registration);
      try {
        registration.registrar.registerInterest(registration.interest);
      } catch {
        this.logger?.warn('Mint Swap quote interest registration failed');
        this.sweepRequested = true;
      }
    }
  }

  private async scan(startup: boolean): Promise<void> {
    try {
      const now = Date.now();
      const full = this.sweepRequested || performance.now() - this.lastSweep >= this.sweepInterval;
      this.sweepRequested = false;
      // A failed active enumeration must not prevent the next ordinary due scan.
      if (full) this.lastSweep = performance.now();
      let candidates: MintSwapOperation[];
      if (full) {
        const active = await this.queries.listActive();
        if (!this.running) return;
        await this.synchronizeInterests(active);
        candidates = active.filter(
          (parent) =>
            parent.state === 'prepared' ||
            (isMintSwapAutomaticState(parent.state) &&
              parent.retry.nextAttemptAt !== null &&
              parent.retry.nextAttemptAt <= now),
        );
      } else {
        candidates = await this.queries.listDue(now, this.batchSize);
        const byId = new Map(candidates.map((parent) => [parent.id, parent]));
        for (const id of this.hinted) {
          const parent = this.parents.get(id);
          if (parent) byId.set(id, parent);
        }
        candidates = [...byId.values()];
      }
      this.hinted.clear();
      if (full) {
        candidates.sort(
          (a, b) =>
            (a.retry.nextAttemptAt ?? Infinity) - (b.retry.nextAttemptAt ?? Infinity) ||
            a.createdAt - b.createdAt ||
            a.id.localeCompare(b.id),
        );
      }
      for (let index = 0; index < candidates.length; index++) {
        if (!this.running) return;
        try {
          await this.service.reconcileInBackground(candidates[index]!.id, startup);
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
