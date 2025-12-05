import type { RealTimeTransport } from './RealTimeTransport.ts';
import type {
  WsRequest,
  WsResponse,
  WsNotification,
  SubscribeParams,
} from './SubscriptionProtocol.ts';
import type { Logger } from '../logging/Logger.ts';
import { MintAdapter } from './MintAdapter.ts';

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

export interface PollingOptions {
  intervalMs?: number; // minimum interval between requests per mint
}

export class PollingTransport implements RealTimeTransport {
  private readonly logger?: Logger;
  private readonly mintAdapter: MintAdapter;
  private readonly options: Required<PollingOptions>;
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
  private paused = false;

  constructor(options?: PollingOptions, logger?: Logger) {
    this.logger = logger;
    this.mintAdapter = new MintAdapter();
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
        const filter = params.filters[0];
        if (!filter) {
          this.logger?.error('PollingTransport: subscribe with no filter', { mintUrl, req });
          return;
        }
        scheduler.queue.push({ subId, kind: params.kind, filter });
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
    this.schedByMint.clear();
    this.listenersByMint.clear();
    this.proofQueueByMint.clear();
    this.proofSetByMint.clear();
    this.yToSubsByMint.clear();
    this.subToYsByMint.clear();
    this.intervalByMint.clear();
  }

  closeMint(mintUrl: string): void {
    this.schedByMint.delete(mintUrl);
    this.listenersByMint.delete(mintUrl);
    this.proofQueueByMint.delete(mintUrl);
    this.proofSetByMint.delete(mintUrl);
    this.yToSubsByMint.delete(mintUrl);
    this.subToYsByMint.delete(mintUrl);
    this.intervalByMint.delete(mintUrl);
    this.logger?.info('PollingTransport closed mint', { mintUrl });
  }

  pause(): void {
    this.paused = true;
    this.logger?.info('PollingTransport paused');
  }

  resume(): void {
    this.paused = false;
    // Trigger maybeRun for all mints with schedulers to restart polling
    for (const mintUrl of this.schedByMint.keys()) {
      void this.maybeRun(mintUrl);
    }
    this.logger?.info('PollingTransport resumed');
  }

  /**
   * Set a custom polling interval for a specific mint.
   * If not set, the default interval from constructor options is used.
   */
  setIntervalForMint(mintUrl: string, intervalMs: number): void {
    this.intervalByMint.set(mintUrl, intervalMs);
    this.logger?.debug('Polling interval changed for mint', { mintUrl, intervalMs });
  }

  /**
   * Get the polling interval for a mint (per-mint or default).
   */
  private getIntervalForMint(mintUrl: string): number {
    return this.intervalByMint.get(mintUrl) ?? this.options.intervalMs;
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
    try {
      const task = s.queue.shift()!;
      await this.performTask(mintUrl, task);
      // re-enqueue for fairness
      s.queue.push(task);
    } catch (err) {
      this.logger?.error('Polling task error', { mintUrl, err });
    } finally {
      s.nextAllowedAt = Date.now() + this.getIntervalForMint(mintUrl);
      s.running = false;
      // Schedule next attempt when allowed
      const delay = Math.max(0, s.nextAllowedAt - Date.now());
      setTimeout(() => {
        void this.maybeRun(mintUrl);
      }, delay);
    }
  }

  private async performTask(mintUrl: string, task: Task): Promise<void> {
    if (task.kind === 'proof_state' && task.batch) {
      const yToSubs = this.yToSubsByMint.get(mintUrl) ?? new Map<string, Set<string>>();
      const queue = this.proofQueueByMint.get(mintUrl) ?? [];
      if (queue.length === 0 || yToSubs.size === 0) return;

      const selected: string[] = [];
      // Pull up to 100 Ys in round robin
      while (selected.length < 100 && queue.length > 0) {
        const y = queue.shift()!;
        const subs = yToSubs.get(y);
        if (subs && subs.size > 0) {
          selected.push(y);
          queue.push(y); // rotate for fairness
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
        payload = await this.mintAdapter.checkMintQuoteState(mintUrl, task.filter!);
        break;
      case 'bolt11_melt_quote':
        payload = await this.mintAdapter.checkMeltQuoteState(mintUrl, task.filter!);
        break;
      default:
        return;
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
