import type { EventBus, CoreEvents } from '@core/events';
import type { Logger } from '../../logging/Logger.ts';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import type { ProofService } from '../ProofService';
import { buildYHexMapsForSecrets } from '../../utils.ts';

type ProofKey = string; // `${mintUrl}::${secret}`

function toKey(mintUrl: string, secret: string): ProofKey {
  return `${mintUrl}::${secret}`;
}

type CheckState = 'UNSPENT' | 'PENDING' | 'SPENT';

type ProofStateNotification = {
  Y: string; // hex
  state: CheckState;
  witness?: unknown;
};

export interface ProofStateWatcherOptions {
  // Potential future option to scan existing inflight proofs on start
  watchExistingInflightOnStart?: boolean;
}

export class ProofStateWatcherService {
  private readonly subs: SubscriptionManager;
  private readonly proofs: ProofService;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly options: ProofStateWatcherOptions;

  private running = false;
  private unsubscribeByKey = new Map<ProofKey, UnsubscribeHandler>();
  private inflightByKey = new Set<ProofKey>();
  private offProofsStateChanged?: () => void;

  constructor(
    subs: SubscriptionManager,
    proofs: ProofService,
    bus: EventBus<CoreEvents>,
    logger?: Logger,
    options: ProofStateWatcherOptions = { watchExistingInflightOnStart: false },
  ) {
    this.subs = subs;
    this.proofs = proofs;
    this.bus = bus;
    this.logger = logger;
    this.options = options;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger?.info('ProofStateWatcherService started');

    // React to proofs being marked inflight
    this.offProofsStateChanged = this.bus.on(
      'proofs:state-changed',
      async ({ mintUrl, secrets, state }) => {
        try {
          if (!this.running) return;
          if (state === 'inflight') {
            try {
              await this.watchProof(mintUrl, secrets);
            } catch (err) {
              this.logger?.warn('Failed to watch inflight proofs', {
                mintUrl,
                count: secrets.length,
                err,
              });
            }
          } else if (state === 'spent') {
            // Stop watching if we already are
            for (const secret of secrets) {
              const key = toKey(mintUrl, secret);
              try {
                await this.stopWatching(key);
              } catch (err) {
                this.logger?.warn('Failed to stop watcher on spent proof', {
                  mintUrl,
                  secret,
                  err,
                });
              }
            }
          }
        } catch (err) {
          this.logger?.error('Error handling proofs:state-changed', { err });
        }
      },
    );

    // Optionally: could scan existing inflight proofs here if repository supports it
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.offProofsStateChanged) {
      try {
        this.offProofsStateChanged();
      } catch {
        // ignore
      } finally {
        this.offProofsStateChanged = undefined;
      }
    }

    const entries = Array.from(this.unsubscribeByKey.entries());
    this.unsubscribeByKey.clear();
    for (const [key, unsub] of entries) {
      try {
        await unsub();
        this.logger?.debug('Stopped watching proof', { key });
      } catch (err) {
        this.logger?.warn('Failed to unsubscribe proof watcher', { key, err });
      }
    }
    this.inflightByKey.clear();
    this.logger?.info('ProofStateWatcherService stopped');
  }

  async watchProof(mintUrl: string, secrets: string[]): Promise<void> {
    if (!this.running) return;

    // Filter out secrets already being watched
    const unique = Array.from(new Set(secrets));
    const toWatch = unique.filter((secret) => !this.unsubscribeByKey.has(toKey(mintUrl, secret)));
    if (toWatch.length === 0) return;

    // Compute Y hex for all secrets and build maps
    const { secretByYHex, yHexBySecret } = buildYHexMapsForSecrets(toWatch);
    const filters = Array.from(secretByYHex.keys());

    const { subId, unsubscribe } = await this.subs.subscribe<ProofStateNotification>(
      mintUrl,
      'proof_state',
      filters,
      async (payload) => {
        if (payload.state !== 'SPENT') return;
        const secret = secretByYHex.get(payload.Y);
        if (!secret) return;
        const key = toKey(mintUrl, secret);
        if (this.inflightByKey.has(key)) return;
        this.inflightByKey.add(key);
        try {
          await this.proofs.setProofState(mintUrl, [secret], 'spent');
          this.logger?.info('Marked inflight proof as spent from mint notification', {
            mintUrl,
            subId,
          });
          await this.stopWatching(key);
        } catch (err) {
          this.logger?.error('Failed to mark inflight proof as spent', { mintUrl, subId, err });
        } finally {
          this.inflightByKey.delete(key);
        }
      },
    );

    // Wrap a group unsubscribe to be idempotent
    let didUnsubscribe = false;
    const remaining = new Set(filters);
    const groupUnsubscribeOnce: UnsubscribeHandler = async () => {
      if (didUnsubscribe) return;
      didUnsubscribe = true;
      await unsubscribe();
      this.logger?.debug('Unsubscribed watcher for inflight proof group', { mintUrl, subId });
    };

    // For each secret, register a per-key stopper that shrinks the remaining set and
    // unsubscribes the group when the last filter is removed
    for (const secret of toWatch) {
      const key = toKey(mintUrl, secret);
      const yHex = yHexBySecret.get(secret)!;
      const perKeyStop: UnsubscribeHandler = async () => {
        if (remaining.has(yHex)) remaining.delete(yHex);
        if (remaining.size === 0) {
          await groupUnsubscribeOnce();
        }
      };
      this.unsubscribeByKey.set(key, perKeyStop);
    }

    this.logger?.debug('Watching inflight proof states', {
      mintUrl,
      subId,
      filterCount: filters.length,
    });
  }

  private async stopWatching(key: ProofKey): Promise<void> {
    const unsubscribe = this.unsubscribeByKey.get(key);
    if (!unsubscribe) return;
    try {
      await unsubscribe();
    } catch (err) {
      this.logger?.warn('Unsubscribe proof watcher failed', { key, err });
    } finally {
      this.unsubscribeByKey.delete(key);
    }
  }
}
