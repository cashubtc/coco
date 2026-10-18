import type { CoreEvents, EventBus } from '../../events';
import type { SubscriptionManager, UnsubscribeHandler } from '../../infra/SubscriptionManager.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { ProofRepository } from '../../repositories';
import type { CoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import type { CoreProof } from '../../types.ts';
import { buildYHexMapsForSecrets, normalizeMintUrl } from '../../utils.ts';
import type { MintService } from '../MintService';

interface WatchGroup {
  keys: Set<string>;
  unsubscribe?: UnsubscribeHandler;
}

interface Watch {
  key: string;
  mintUrl: string;
  secret: string;
  group: WatchGroup;
  tail: Promise<unknown>;
}

function isUnownedPending(proof: CoreProof): boolean {
  return (
    proof.state === 'pending' &&
    proof.usedByOperationId == null &&
    proof.createdByOperationId == null
  );
}

/** Watches only mint-held proofs without an owning operation. Send/Melt keep their own authority. */
export class PendingProofWatcherService {
  private session?: AbortController;
  private stopping?: Promise<void>;
  private readonly watches = new Map<string, Watch>();
  private readonly work = new Set<Promise<unknown>>();
  private listeners: (() => void)[] = [];

  constructor(
    private readonly subs: SubscriptionManager,
    private readonly mintService: Pick<MintService, 'isTrustedMint'>,
    private readonly proofs: ProofRepository,
    private readonly transactionRunner: CoreTransactionRunner,
    private readonly bus: EventBus<CoreEvents>,
    private readonly logger?: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.session) return;
    const session = new AbortController();
    this.session = session;
    const refresh = (mintUrl: string, secrets: string[]) =>
      this.track(async () => {
        if (session.signal.aborted) return;
        const proofs = await this.proofs.getProofsBySecrets(normalizeMintUrl(mintUrl), secrets);
        if (session.signal.aborted) return;
        await this.watch(proofs, session.signal);
        // Events can be stale when an earlier listener has already started a Send.
        for (const secret of secrets) {
          const watch = this.watches.get(`${normalizeMintUrl(mintUrl)}::${secret}`);
          if (
            watch &&
            !proofs.some((proof) => proof.secret === secret && isUnownedPending(proof))
          ) {
            await this.remove(watch);
          }
        }
      });
    this.listeners = [
      this.bus.on('proofs:saved', ({ mintUrl, proofs }) =>
        refresh(
          mintUrl,
          proofs.map((p) => p.secret),
        ),
      ),
      this.bus.on('proofs:state-changed', ({ mintUrl, secrets }) => refresh(mintUrl, secrets)),
      this.bus.on('mint:untrusted', ({ mintUrl }) =>
        this.track(async () => {
          if (session.signal.aborted) return;
          const removed = [...this.watches.values()].filter(
            (w) => w.mintUrl === normalizeMintUrl(mintUrl),
          );
          await Promise.all(removed.map((watch) => this.remove(watch)));
        }),
      ),
      this.bus.on('mint:trusted', () => this.track(() => this.bootstrap(session.signal))),
    ];
    await this.track(() => this.bootstrap(session.signal));
  }

  /** Drain acquisitions and local writes. Publication is cancellable and never part of that drain. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.session?.abort();
    this.session = undefined;
    for (const off of this.listeners) off();
    this.listeners = [];
    const releases = [...this.watches.values()].map((watch) => this.remove(watch));
    this.stopping = (async () => {
      await Promise.all(releases);
      while (this.work.size) await Promise.all([...this.work]);
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private track<T>(action: () => Promise<T>): Promise<T | undefined> {
    const task = action().catch((error) => {
      this.logger?.warn('Pending proof watcher failed', { error });
      return undefined;
    });
    this.work.add(task);
    void task.then(() => this.work.delete(task));
    return task;
  }

  private async bootstrap(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const proofs = await this.proofs.getPendingProofs();
    await this.watch(proofs, signal);
  }

  private async watch(proofs: CoreProof[], signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const byMint = new Map<string, CoreProof[]>();
    for (const proof of proofs.filter(isUnownedPending)) {
      const mintUrl = normalizeMintUrl(proof.mintUrl);
      const batch = byMint.get(mintUrl) ?? [];
      batch.push(proof);
      byMint.set(mintUrl, batch);
    }
    for (const [mintUrl, batch] of byMint) {
      if (signal.aborted) return;
      const group: WatchGroup = { keys: new Set() };
      const watches: Watch[] = [];
      // Reserve each key before the first await, so stop/untrust/state events can invalidate it.
      for (const proof of batch) {
        const key = `${mintUrl}::${proof.secret}`;
        if (this.watches.has(key)) continue;
        const watch: Watch = { key, mintUrl, secret: proof.secret, group, tail: Promise.resolve() };
        this.watches.set(key, watch);
        group.keys.add(key);
        watches.push(watch);
      }
      if (!watches.length) continue;
      try {
        if (
          !(await this.mintService.isTrustedMint(mintUrl)) ||
          signal.aborted ||
          !group.keys.size
        ) {
          for (const watch of watches) await this.remove(watch);
          continue;
        }
        const { secretByYHex } = buildYHexMapsForSecrets(watches.map((w) => w.secret));
        const bySecret = new Map(watches.map((watch) => [watch.secret, watch]));
        const subscription = await this.subs.subscribe<{ Y: string; state: string }>(
          mintUrl,
          'proof_state',
          [...secretByYHex.keys()],
          (payload) => {
            const secret = secretByYHex.get(payload.Y);
            const watch = secret && bySecret.get(secret);
            if (
              !watch ||
              !this.active(watch, signal) ||
              !['UNSPENT', 'SPENT'].includes(payload.state)
            )
              return;
            const state = payload.state === 'UNSPENT' ? 'ready' : 'spent';
            // Queue observations through commit, but never hold that queue across app listeners.
            const previous = watch.tail;
            const applied = this.track(async () => {
              await previous;
              if (!this.active(watch, signal)) return false;
              const changed = await this.transactionRunner.run((tx) =>
                tx.proofs.reconcilePending(mintUrl, watch.secret, state),
              );
              await this.remove(watch);
              return changed;
            });
            watch.tail = applied;
            return applied.then(async (changed) => {
              if (changed)
                await this.bus.emit(
                  'proofs:state-changed',
                  {
                    mintUrl,
                    secrets: [watch.secret],
                    state,
                  },
                  { signal },
                );
            });
          },
        );
        group.unsubscribe = subscription.unsubscribe;
        // A state change or shutdown may have removed every key while subscribe was pending.
        if (!group.keys.size) await this.release(group);
        const current = await this.proofs.getProofsBySecrets(
          mintUrl,
          watches.map((w) => w.secret),
        );
        for (const watch of watches) {
          if (
            signal.aborted ||
            !current.some((p) => p.secret === watch.secret && isUnownedPending(p))
          ) {
            await this.remove(watch);
          }
        }
      } catch (error) {
        for (const watch of watches) await this.remove(watch);
        this.logger?.warn('Could not subscribe to pending proofs', { mintUrl, error });
      }
    }
  }

  private active(watch: Watch, signal: AbortSignal): boolean {
    return !signal.aborted && this.watches.get(watch.key) === watch;
  }

  private async remove(watch: Watch): Promise<void> {
    if (this.watches.get(watch.key) !== watch) return;
    this.watches.delete(watch.key);
    watch.group.keys.delete(watch.key);
    if (!watch.group.keys.size) await this.release(watch.group);
  }

  private async release(group: WatchGroup): Promise<void> {
    const unsubscribe = group.unsubscribe;
    group.unsubscribe = undefined;
    try {
      await unsubscribe?.();
    } catch (error) {
      this.logger?.warn('Could not unsubscribe pending proofs', { error });
    }
  }
}
