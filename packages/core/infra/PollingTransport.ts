import type { RealTimeTransport } from './RealTimeTransport.ts';
import type {
  WsRequest,
  WsResponse,
  WsNotification,
  SubscribeParams,
  SubscriptionKind,
} from './SubscriptionProtocol.ts';
import type { Logger } from '../logging/Logger.ts';
import type { MintAdapter } from './MintAdapter.ts';
import type { MintMethod } from '../operations/mint/MintMethodHandler.ts';
import type {
  MintQuotePollingChecker,
  MintQuotePollingCheckResult,
  MintQuotePollingInterestProvider,
} from './MintQuotePollingChecker.ts';
import { normalizeMintUrl } from '../utils.ts';

type Task = {
  subId?: string; // undefined for proof batch sentinel
  kind: SubscribeParams['kind'];
  filter?: string; // single id per subscription (quotes); not used for proof batch
  batch?: boolean; // true for proof_state batch sentinel
};

type MintScheduler = {
  nextAllowedAt: number;
  queue: Task[];
  running: boolean;
  hasProofBatchTask: boolean;
};

type MintQuoteBackoff = {
  failures: number;
  nextEligibleAt: number;
};

const SUPPORTED_POLLING_KINDS = new Set<SubscriptionKind>([
  'bolt11_mint_quote',
  'onchain_mint_quote',
  'bolt12_mint_quote',
  'bolt11_melt_quote',
  'bolt12_melt_quote',
  'onchain_melt_quote',
  'proof_state',
]);

export interface PollingOptions {
  intervalMs?: number; // minimum interval between requests per mint
}

export class PollingTransport implements RealTimeTransport, MintQuotePollingInterestProvider {
  private readonly logger?: Logger;
  private readonly mintAdapter: MintAdapter;
  private readonly options: Required<PollingOptions>;
  private readonly mintQuoteChecker?: MintQuotePollingChecker;
  private readonly unregisterMintQuotePollingInterestProvider?: () => void;
  private readonly listenersByMint = new Map<
    string,
    Map<'open' | 'message' | 'error' | 'close', Set<(event: any) => void>>
  >();
  private readonly schedByMint = new Map<string, MintScheduler>();
  private readonly proofQueueByMint = new Map<string, string[]>();
  private readonly proofSetByMint = new Map<string, Set<string>>();
  private readonly yToSubsByMint = new Map<string, Map<string, Set<string>>>();
  private readonly subToYsByMint = new Map<string, Map<string, Set<string>>>();
  private readonly intervalByMint = new Map<string, number>();
  private readonly mintQuoteBackoff = new Map<
    string,
    Map<MintMethod, Map<string, MintQuoteBackoff>>
  >();
  // Track unsubscribed subIds to prevent re-enqueuing tasks that are currently being processed
  private readonly unsubscribedByMint = new Map<string, Set<string>>();
  private paused = false;

  constructor(
    mintAdapter: MintAdapter,
    options?: PollingOptions,
    logger?: Logger,
    mintQuoteChecker?: MintQuotePollingChecker,
  ) {
    this.logger = logger;
    this.mintAdapter = mintAdapter;
    this.mintQuoteChecker = mintQuoteChecker;
    this.unregisterMintQuotePollingInterestProvider =
      mintQuoteChecker?.registerMintQuotePollingInterestProvider?.(this);
    this.options = {
      intervalMs: options?.intervalMs ?? 5000,
    };
  }

  on(
    mintUrl: string,
    event: 'open' | 'message' | 'error' | 'close',
    handler: (evt: any) => void,
  ): void {
    let map = this.listenersByMint.get(mintUrl);
    if (!map) {
      map = new Map();
      this.listenersByMint.set(mintUrl, map);
    }
    let set = map.get(event);
    if (!set) {
      set = new Set();
      map.set(event, set);
    }
    if (!set.has(handler)) set.add(handler);

    // Emit synthetic open exactly once per mint
    if (event === 'open') {
      const already = (map.get('open')?.size ?? 0) > 0;
      if (!already) {
        queueMicrotask(() => {
          try {
            handler({ type: 'open' });
          } catch {}
        });
      }
    }

    // Ensure scheduler exists
    this.ensureScheduler(mintUrl);
  }

  send(mintUrl: string, req: WsRequest): void {
    if (req.method === 'subscribe') {
      const params = req.params as SubscribeParams;
      const subId = params.subId;

      if (!this.isSupportedPollingKind(params.kind)) {
        this.logger?.error('PollingTransport: unsupported subscription kind', {
          mintUrl,
          kind: params.kind,
          req,
        });
        const resp: WsResponse = {
          jsonrpc: '2.0',
          error: {
            code: -32602,
            message: `Unsupported subscription kind: ${String(params.kind)}`,
          },
          id: req.id,
        };
        this.emit(mintUrl, 'message', { data: JSON.stringify(resp) });
        return;
      }

      const scheduler = this.ensureScheduler(mintUrl);

      if (params.kind === 'proof_state') {
        const ys = params.filters || [];
        if (!ys.length) {
          this.logger?.error('PollingTransport: subscribe proof_state with no filters', {
            mintUrl,
            req,
          });
        }
        let yToSubs = this.yToSubsByMint.get(mintUrl);
        if (!yToSubs) {
          yToSubs = new Map();
          this.yToSubsByMint.set(mintUrl, yToSubs);
        }
        let subToYs = this.subToYsByMint.get(mintUrl);
        if (!subToYs) {
          subToYs = new Map();
          this.subToYsByMint.set(mintUrl, subToYs);
        }
        let q = this.proofQueueByMint.get(mintUrl);
        if (!q) {
          q = [];
          this.proofQueueByMint.set(mintUrl, q);
        }
        let set = this.proofSetByMint.get(mintUrl);
        if (!set) {
          set = new Set();
          this.proofSetByMint.set(mintUrl, set);
        }

        // Map subId -> Ys
        let subYs = subToYs.get(subId);
        if (!subYs) {
          subYs = new Set();
          subToYs.set(subId, subYs);
        }

        for (const y of ys) {
          subYs.add(y);
          let subs = yToSubs.get(y);
          if (!subs) {
            subs = new Set();
            yToSubs.set(y, subs);
          }
          subs.add(subId);
          if (!set.has(y)) {
            set.add(y);
            q.push(y);
          }
        }

        if (!scheduler.hasProofBatchTask) {
          scheduler.queue.push({ kind: 'proof_state', batch: true });
          scheduler.hasProofBatchTask = true;
        }
      } else {
        const filters = params.filters ?? [];
        if (filters.length === 0) {
          this.logger?.error('PollingTransport: subscribe with no filter', { mintUrl, req });
          return;
        }
        for (const filter of filters) {
          scheduler.queue.push({ subId, kind: params.kind, filter });
        }
      }

      // Acknowledge subscribe immediately
      const resp: WsResponse = { jsonrpc: '2.0', result: { status: 'OK', subId }, id: req.id };
      this.emit(mintUrl, 'message', { data: JSON.stringify(resp) });

      // Try to run now if allowed
      void this.maybeRun(mintUrl);
      return;
    }

    if (req.method === 'unsubscribe') {
      const subId = (req.params as any).subId as string;
      const scheduler = this.ensureScheduler(mintUrl);
      scheduler.queue = scheduler.queue.filter((t) => t.subId !== subId);

      // Track unsubscribed subId to prevent re-enqueuing if task is currently being processed
      let unsubscribed = this.unsubscribedByMint.get(mintUrl);
      if (!unsubscribed) {
        unsubscribed = new Set();
        this.unsubscribedByMint.set(mintUrl, unsubscribed);
      }
      unsubscribed.add(subId);

      // Clean proof mappings
      const subToYs = this.subToYsByMint.get(mintUrl);
      const yToSubs = this.yToSubsByMint.get(mintUrl);
      const q = this.proofQueueByMint.get(mintUrl);
      const set = this.proofSetByMint.get(mintUrl);
      if (subToYs && yToSubs) {
        const ys = subToYs.get(subId);
        if (ys) {
          for (const y of ys) {
            const subs = yToSubs.get(y);
            if (subs) {
              subs.delete(subId);
              if (subs.size === 0) {
                yToSubs.delete(y);
                if (set) set.delete(y);
                if (q) {
                  const idx = q.indexOf(y);
                  if (idx >= 0) q.splice(idx, 1);
                }
              }
            }
          }
          subToYs.delete(subId);
        }
        // If no Ys remain, remove proof batch task
        if (yToSubs.size === 0 && scheduler.hasProofBatchTask) {
          scheduler.queue = scheduler.queue.filter((t) => !(t.kind === 'proof_state' && t.batch));
          scheduler.hasProofBatchTask = false;
        }
      }
      return;
    }
  }

  closeAll(): void {
    this.unregisterMintQuotePollingInterestProvider?.();
    this.schedByMint.clear();
    this.listenersByMint.clear();
    this.proofQueueByMint.clear();
    this.proofSetByMint.clear();
    this.yToSubsByMint.clear();
    this.subToYsByMint.clear();
    this.intervalByMint.clear();
    this.unsubscribedByMint.clear();
    this.mintQuoteBackoff.clear();
  }

  closeMint(mintUrl: string): void {
    this.schedByMint.delete(mintUrl);
    this.listenersByMint.delete(mintUrl);
    this.proofQueueByMint.delete(mintUrl);
    this.proofSetByMint.delete(mintUrl);
    this.yToSubsByMint.delete(mintUrl);
    this.subToYsByMint.delete(mintUrl);
    this.intervalByMint.delete(mintUrl);
    this.unsubscribedByMint.delete(mintUrl);
    this.mintQuoteBackoff.delete(mintUrl);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    // Trigger maybeRun for all mints with schedulers to restart polling
    for (const mintUrl of this.schedByMint.keys()) {
      void this.maybeRun(mintUrl);
    }
  }

  /**
   * Set a custom polling interval for a specific mint.
   * If not set, the default interval from constructor options is used.
   */
  setIntervalForMint(mintUrl: string, intervalMs: number): void {
    this.intervalByMint.set(mintUrl, intervalMs);
  }

  /**
   * Get the polling interval for a mint (per-mint or default).
   */
  private getIntervalForMint(mintUrl: string): number {
    return this.intervalByMint.get(mintUrl) ?? this.options.intervalMs;
  }

  private isSupportedPollingKind(kind: unknown): kind is SubscriptionKind {
    return typeof kind === 'string' && SUPPORTED_POLLING_KINDS.has(kind as SubscriptionKind);
  }

  private ensureScheduler(mintUrl: string): MintScheduler {
    let s = this.schedByMint.get(mintUrl);
    if (!s) {
      s = { nextAllowedAt: 0, queue: [], running: false, hasProofBatchTask: false };
      this.schedByMint.set(mintUrl, s);
      // Initialize maps for proof batching
      if (!this.proofQueueByMint.get(mintUrl)) this.proofQueueByMint.set(mintUrl, []);
      if (!this.proofSetByMint.get(mintUrl)) this.proofSetByMint.set(mintUrl, new Set());
      if (!this.yToSubsByMint.get(mintUrl)) this.yToSubsByMint.set(mintUrl, new Map());
      if (!this.subToYsByMint.get(mintUrl)) this.subToYsByMint.set(mintUrl, new Map());
    }
    return s;
  }

  private async maybeRun(mintUrl: string): Promise<void> {
    if (this.paused) return;
    const s = this.ensureScheduler(mintUrl);
    if (s.running) return;
    const now = Date.now();
    if (now < s.nextAllowedAt) return;
    if (s.queue.length === 0) return;

    s.running = true;
    const task = this.takeNextEligibleTask(mintUrl, s, now);
    if (!task) {
      s.running = false;
      this.scheduleNextEligibleMintQuoteTask(mintUrl, s, now);
      return;
    }
    const tasks = [task];
    if (this.mintQuoteChecker && this.getMintMethod(task.kind)) {
      for (let index = 0; index < s.queue.length && tasks.length < 100; ) {
        const candidate = s.queue[index];
        if (
          candidate?.kind === task.kind &&
          this.isMintQuoteTaskEligible(mintUrl, candidate, now)
        ) {
          tasks.push(candidate);
          s.queue.splice(index, 1);
        } else {
          index++;
        }
      }
    }

    let mintQuoteResult: MintQuotePollingCheckResult | undefined;
    try {
      if (this.mintQuoteChecker && this.getMintMethod(task.kind)) {
        mintQuoteResult = await this.performMintQuoteTasks(mintUrl, tasks);
        this.updateMintQuoteBackoff(mintUrl, task.kind, mintQuoteResult);
      } else {
        await this.performTask(mintUrl, task);
      }
    } catch (err) {
      this.logger?.error('Polling task error', { mintUrl, err });
    } finally {
      // Keep active interests eligible after both successful and failed polling opportunities.
      const unsubscribed = this.unsubscribedByMint.get(mintUrl);
      const attempted = new Set(mintQuoteResult?.attemptedQuoteIds ?? []);
      const requeueTasks = mintQuoteResult
        ? [
            ...tasks.filter((completedTask) => !attempted.has(completedTask.filter ?? '')),
            ...tasks.filter((completedTask) => attempted.has(completedTask.filter ?? '')),
          ]
        : tasks;
      const completedUnsubscribed = new Set<string>();
      for (const completedTask of requeueTasks) {
        const wasUnsubscribed = completedTask.subId && unsubscribed?.has(completedTask.subId);
        if (wasUnsubscribed) {
          completedUnsubscribed.add(completedTask.subId!);
        } else {
          s.queue.push(completedTask);
        }
      }
      for (const subId of completedUnsubscribed) unsubscribed!.delete(subId);
      s.nextAllowedAt = Date.now() + this.getIntervalForMint(mintUrl);
      s.running = false;
      // Schedule next attempt when allowed
      const delay = Math.max(0, s.nextAllowedAt - Date.now());
      setTimeout(() => {
        void this.maybeRun(mintUrl);
      }, delay);
    }
  }

  private getMintQuoteBackoff(mintUrl: string, task: Task): MintQuoteBackoff | undefined {
    const method = this.getMintMethod(task.kind);
    return method && task.filter
      ? this.mintQuoteBackoff.get(mintUrl)?.get(method)?.get(task.filter)
      : undefined;
  }

  private isMintQuoteTaskEligible(mintUrl: string, task: Task, now: number): boolean {
    return (this.getMintQuoteBackoff(mintUrl, task)?.nextEligibleAt ?? 0) <= now;
  }

  private takeNextEligibleTask(
    mintUrl: string,
    scheduler: MintScheduler,
    now: number,
  ): Task | undefined {
    const index = scheduler.queue.findIndex((task) =>
      this.isMintQuoteTaskEligible(mintUrl, task, now),
    );
    if (index < 0) return undefined;
    return scheduler.queue.splice(index, 1)[0];
  }

  private scheduleNextEligibleMintQuoteTask(
    mintUrl: string,
    scheduler: MintScheduler,
    now: number,
  ): void {
    const nextEligibleAt = scheduler.queue.reduce((earliest, task) => {
      const candidate = this.getMintQuoteBackoff(mintUrl, task)?.nextEligibleAt;
      return candidate === undefined ? earliest : Math.min(earliest, candidate);
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextEligibleAt)) return;
    setTimeout(() => void this.maybeRun(mintUrl), Math.max(0, nextEligibleAt - now));
  }

  private updateMintQuoteBackoff(
    mintUrl: string,
    kind: SubscriptionKind,
    result: MintQuotePollingCheckResult,
  ): void {
    const method = this.getMintMethod(kind);
    if (!method) return;
    const observed = new Set(result.observations.map((observation) => observation.quote));
    let byMethod = this.mintQuoteBackoff.get(mintUrl);
    if (!byMethod) {
      byMethod = new Map();
      this.mintQuoteBackoff.set(mintUrl, byMethod);
    }
    let byQuote = byMethod.get(method);
    if (!byQuote) {
      byQuote = new Map();
      byMethod.set(method, byQuote);
    }
    for (const quoteId of result.attemptedQuoteIds) {
      if (observed.has(quoteId)) {
        byQuote.delete(quoteId);
        continue;
      }
      const failures = (byQuote.get(quoteId)?.failures ?? 0) + 1;
      const baseDelay = Math.max(1_000, this.getIntervalForMint(mintUrl));
      const delayMs = Math.min(60_000, baseDelay * 2 ** Math.min(failures, 6));
      byQuote.set(quoteId, { failures, nextEligibleAt: Date.now() + delayMs });
    }
  }

  private getMintMethod(kind: SubscriptionKind): MintMethod | undefined {
    switch (kind) {
      case 'bolt11_mint_quote':
        return 'bolt11';
      case 'bolt12_mint_quote':
        return 'bolt12';
      case 'onchain_mint_quote':
        return 'onchain';
      default:
        return undefined;
    }
  }

  /** Returns eligible queued interests in deterministic scheduler order. */
  getQueuedMintQuoteIds(mintUrl: string, method: MintMethod): string[] {
    const normalizedMintUrl = normalizeMintUrl(mintUrl);
    const quoteIds: string[] = [];
    const seen = new Set<string>();
    const now = Date.now();
    for (const [scheduledMintUrl, scheduler] of this.schedByMint) {
      if (normalizeMintUrl(scheduledMintUrl) !== normalizedMintUrl) continue;
      for (const task of scheduler.queue) {
        if (
          this.getMintMethod(task.kind) !== method ||
          !task.filter ||
          !this.isMintQuoteTaskEligible(scheduledMintUrl, task, now) ||
          seen.has(task.filter)
        ) {
          continue;
        }
        seen.add(task.filter);
        quoteIds.push(task.filter);
      }
    }
    return quoteIds;
  }

  private async performMintQuoteTasks(
    mintUrl: string,
    tasks: Task[],
  ): Promise<MintQuotePollingCheckResult> {
    const first = tasks[0];
    const method = first ? this.getMintMethod(first.kind) : undefined;
    if (!first || !method || !this.mintQuoteChecker) {
      return { attemptedQuoteIds: [], observations: [] };
    }

    const result = await this.mintQuoteChecker.checkMintQuotesForPolling(
      mintUrl,
      method,
      Array.from(new Set(tasks.map((task) => task.filter!).filter(Boolean))),
    );
    for (const observation of result.observations) {
      for (const task of tasks) {
        if (task.filter !== observation.quote || !task.subId) continue;
        const notification: WsNotification<unknown> = {
          jsonrpc: '2.0',
          method: 'subscribe',
          params: { subId: task.subId, payload: observation },
        };
        this.emit(mintUrl, 'message', { data: JSON.stringify(notification) });
      }
    }
    return result;
  }

  private async performTask(mintUrl: string, task: Task): Promise<void> {
    if (task.kind === 'proof_state' && task.batch) {
      const yToSubs = this.yToSubsByMint.get(mintUrl) ?? new Map<string, Set<string>>();
      const queue = this.proofQueueByMint.get(mintUrl) ?? [];
      if (queue.length === 0 || yToSubs.size === 0) return;

      const selected: string[] = [];
      const selectedSet = new Set<string>();
      let remaining = queue.length;
      // Pull up to 100 unique Ys in round robin.
      while (selected.length < 100 && remaining > 0 && queue.length > 0) {
        remaining--;
        const y = queue.shift()!;
        const subs = yToSubs.get(y);
        if (subs && subs.size > 0 && !selectedSet.has(y)) {
          selected.push(y);
          selectedSet.add(y);
          queue.push(y); // rotate for fairness
        } else if (subs && subs.size > 0) {
          // Drop duplicate queue entries while keeping the rotated selected entry.
          continue;
        } else {
          // drop stale y (no subscribers)
          const set = this.proofSetByMint.get(mintUrl);
          if (set) set.delete(y);
          // do not re-enqueue
        }
      }
      if (selected.length === 0) return;

      const results = await this.mintAdapter.checkProofStates(mintUrl, selected);
      for (let i = 0; i < results.length; i++) {
        const payload = results[i] as any;
        const yFromPayload =
          payload && typeof payload.Y === 'string' ? (payload.Y as string) : undefined;
        const y = yFromPayload ?? selected[i] ?? '';
        if (!y) continue;
        const subs = yToSubs.get(y);
        if (!subs) continue;
        for (const subId of subs.values()) {
          const notification: WsNotification<unknown> = {
            jsonrpc: '2.0',
            method: 'subscribe',
            params: { subId, payload },
          };
          this.emit(mintUrl, 'message', { data: JSON.stringify(notification) });
        }
      }
      return;
    }

    // Non-proof tasks
    let payload: unknown;
    switch (task.kind) {
      case 'bolt11_mint_quote':
        payload = await this.mintAdapter.checkMintQuote(mintUrl, 'bolt11', task.filter!);
        break;
      case 'onchain_mint_quote':
        payload = await this.mintAdapter.checkMintQuote(mintUrl, 'onchain', task.filter!);
        break;
      case 'bolt12_mint_quote':
        payload = await this.mintAdapter.checkMintQuote(mintUrl, 'bolt12', task.filter!);
        break;
      case 'bolt11_melt_quote':
        payload = await this.mintAdapter.checkMeltQuoteState(mintUrl, task.filter!);
        break;
      case 'bolt12_melt_quote':
        payload = await this.mintAdapter.checkMeltQuoteBolt12State(mintUrl, task.filter!);
        break;
      case 'onchain_melt_quote':
        payload = await this.mintAdapter.checkMeltQuoteOnchain(mintUrl, task.filter!);
        break;
      default:
        throw new Error(`Unsupported polling task kind: ${String(task.kind)}`);
    }
    const notification: WsNotification<unknown> = {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { subId: task.subId!, payload },
    };
    this.emit(mintUrl, 'message', { data: JSON.stringify(notification) });
  }

  private emit(mintUrl: string, event: 'open' | 'message' | 'error' | 'close', evt: any): void {
    const map = this.listenersByMint.get(mintUrl);
    const set = map?.get(event);
    if (!set) return;
    for (const handler of set.values()) {
      try {
        handler(evt);
      } catch {}
    }
  }
}
