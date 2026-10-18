import type { EventBus, CoreEvents } from '@core/events';
import type { Logger } from '../../logging/Logger.ts';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import type { CoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { reconcileRestoredPending } from '../../operations/restore/RestoreTransitions.ts';
import type { MintService } from '../MintService';
import type { ProofService } from '../ProofService';
import type { SendOperationService } from '../../operations/send/SendOperationService';
import { getSendProofSecrets, hasPreparedData } from '../../operations/send/SendOperation';
import type { ProofRepository } from '../../repositories';
import { buildYHexMapsForSecrets } from '../../utils.ts';

type ProofKey = string; // `${mintUrl}::${secret}`

type ProofWatch = {
  unsubscribe: UnsubscribeHandler;
  revision: number;
};

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
  // Scan existing inflight and pending proofs on start.
  watchExistingInflightOnStart?: boolean;
}

export class ProofStateWatcherService {
  private readonly subs: SubscriptionManager;
  private readonly mintService: MintService;
  private readonly proofs: ProofService;
  private readonly proofRepository: ProofRepository;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly options: ProofStateWatcherOptions;
  private sendOperationService?: SendOperationService;

  private running = false;
  private epoch = 0;
  private stopping?: Promise<void>;
  private eventDelivery = new AbortController();
  private readonly ownedWork = new Set<Promise<void>>();
  private readonly acquiringByKey = new Set<ProofKey>();
  private readonly mintGeneration = new Map<string, number>();
  private watchByKey = new Map<ProofKey, ProofWatch>();
  private readonly processingByKey = new Map<ProofKey, Promise<void>>();
  private offProofsStateChanged?: () => void;
  private offProofsSaved?: () => void;
  private offUntrusted?: () => void;

  constructor(
    private readonly transactionRunner: CoreTransactionRunner,
    subs: SubscriptionManager,
    mintService: MintService,
    proofs: ProofService,
    proofRepository: ProofRepository,
    bus: EventBus<CoreEvents>,
    logger?: Logger,
    options: ProofStateWatcherOptions = { watchExistingInflightOnStart: true },
  ) {
    this.subs = subs;
    this.mintService = mintService;
    this.proofs = proofs;
    this.proofRepository = proofRepository;
    this.bus = bus;
    this.logger = logger;
    this.options = options;
  }

  /**
   * Set the SendOperationService for auto-finalizing send operations.
   * This is set after construction to avoid circular dependencies.
   */
  setSendOperationService(service: SendOperationService): void {
    this.sendOperationService = service;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.running) return;
    this.running = true;
    this.eventDelivery = new AbortController();
    const epoch = ++this.epoch;
    this.logger?.info('ProofStateWatcherService started');

    // React to proofs being marked inflight via state change
    this.offProofsStateChanged = this.bus.on(
      'proofs:state-changed',
      ({ mintUrl, secrets, state }) =>
        this.runOwned(async () => {
          try {
            if (!this.running || epoch !== this.epoch) return;
            if (state === 'inflight' || state === 'pending') {
              try {
                await this.watchProof(mintUrl, secrets);
              } catch (err) {
                this.logger?.warn('Failed to watch inflight proofs', {
                  mintUrl,
                  count: secrets.length,
                  err,
                });
              }
            } else if (state === 'ready') {
              for (const secret of secrets) {
                const key = toKey(mintUrl, secret);
                const subscription = this.watchByKey.get(key);
                if (!subscription) continue;
                const revision = subscription.revision;
                // Earlier listeners may have spent the proof before this event reaches us.
                const proof = await this.proofRepository.getProofBySecret(mintUrl, secret);
                if (!this.running || epoch !== this.epoch) return;
                if (proof?.state === 'ready' && subscription.revision === revision) {
                  await this.stopWatching(key, subscription);
                }
              }
            } else if (state === 'spent') {
              const operationIds = new Set<string>();

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

                if (!this.sendOperationService) continue;

                try {
                  const operationId = await this.getSendOperationIdForSpentProof(mintUrl, secret);
                  if (operationId) {
                    operationIds.add(operationId);
                  }
                } catch (err) {
                  this.logger?.warn('Failed to resolve send operation from spent proof event', {
                    mintUrl,
                    secret,
                    err,
                  });
                }
              }

              for (const operationId of operationIds) {
                await this.tryFinalizeSendOperation(mintUrl, operationId);
              }
            }
          } catch (err) {
            this.logger?.error('Error handling proofs:state-changed', { err });
          }
        }),
    );

    // React to proofs being saved with inflight state (e.g., from swap operations)
    this.offProofsSaved = this.bus.on('proofs:saved', ({ mintUrl, proofs }) =>
      this.runOwned(async () => {
        try {
          if (!this.running || epoch !== this.epoch) return;
          const inflightSecrets = proofs
            .filter((p) => p.state === 'inflight' || p.state === 'pending')
            .map((p) => p.secret);
          if (inflightSecrets.length > 0) {
            try {
              await this.watchProof(mintUrl, inflightSecrets);
            } catch (err) {
              this.logger?.warn('Failed to watch inflight proofs from saved event', {
                mintUrl,
                count: inflightSecrets.length,
                err,
              });
            }
          }
        } catch (err) {
          this.logger?.error('Error handling proofs:saved', { err });
        }
      }),
    );

    // Stop watching proofs when mint is untrusted
    this.offUntrusted = this.bus.on('mint:untrusted', ({ mintUrl }) =>
      this.runOwned(async () => {
        try {
          if (epoch !== this.epoch) return;
          await this.stopWatchingMint(mintUrl);
        } catch (err) {
          this.logger?.error('Failed to stop watching mint proofs on untrust', { mintUrl, err });
        }
      }),
    );

    if (this.options.watchExistingInflightOnStart) {
      void this.runOwned(() => this.bootstrapInflightProofs()).catch((err) => {
        this.logger?.warn('Failed to bootstrap inflight proof watchers', { err });
      });
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.running) return Promise.resolve();
    this.running = false;
    // A listener may itself await stop(). Cancel this publication instead of waiting on it.
    this.eventDelivery.abort();
    this.stopping = this.drainAndStop().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async drainAndStop(): Promise<void> {
    if (this.offProofsStateChanged) {
      try {
        this.offProofsStateChanged();
      } catch {
        // ignore
      } finally {
        this.offProofsStateChanged = undefined;
      }
    }

    if (this.offProofsSaved) {
      try {
        this.offProofsSaved();
      } catch {
        // ignore
      } finally {
        this.offProofsSaved = undefined;
      }
    }

    if (this.offUntrusted) {
      try {
        this.offUntrusted();
      } catch {
        // ignore
      } finally {
        this.offUntrusted = undefined;
      }
    }

    // In-progress subscriptions release themselves when they see running=false. Drain owned work,
    // including active transactions; cancelled event delivery cannot start another listener.
    while (this.ownedWork.size) await Promise.allSettled([...this.ownedWork]);
    const entries = Array.from(this.watchByKey.entries());
    this.watchByKey.clear();
    for (const [key, watch] of entries) {
      try {
        await watch.unsubscribe();
        this.logger?.debug('Stopped watching proof', { key });
      } catch (err) {
        this.logger?.warn('Failed to unsubscribe proof watcher', { key, err });
      }
    }
    this.processingByKey.clear();
    this.logger?.info('ProofStateWatcherService stopped');
  }

  private runOwned(work: () => Promise<void>): Promise<void> {
    if (!this.running) return Promise.resolve();
    const task = Promise.resolve().then(work);
    this.ownedWork.add(task);
    void task.finally(() => this.ownedWork.delete(task)).catch(() => {});
    return task;
  }

  watchProof(mintUrl: string, secrets: string[]): Promise<void> {
    // A new watch request supersedes an older ready event, even when reusing the subscription.
    for (const secret of secrets) {
      const watch = this.watchByKey.get(toKey(mintUrl, secret));
      if (watch) watch.revision++;
    }
    return this.runOwned(() => this.acquireWatch(mintUrl, secrets));
  }

  private async acquireWatch(mintUrl: string, secrets: string[]): Promise<void> {
    if (!this.running) return;

    // Only watch proofs for trusted mints
    const epoch = this.epoch;
    const eventSignal = this.eventDelivery.signal;
    const generation = this.mintGeneration.get(mintUrl) ?? 0;
    const isActive = () =>
      this.running &&
      epoch === this.epoch &&
      (this.mintGeneration.get(mintUrl) ?? 0) === generation;
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted || !isActive()) {
      this.logger?.debug('Skipping watch for untrusted mint', { mintUrl });
      return;
    }

    // Filter out secrets already being watched
    const unique = Array.from(new Set(secrets));
    const toWatch = unique.filter(
      (secret) =>
        !this.watchByKey.has(toKey(mintUrl, secret)) &&
        !this.acquiringByKey.has(toKey(mintUrl, secret)),
    );
    if (toWatch.length === 0) return;

    for (const secret of toWatch) this.acquiringByKey.add(toKey(mintUrl, secret));
    try {
      // Compute Y hex for all secrets and build maps
      const { secretByYHex, yHexBySecret } = buildYHexMapsForSecrets(toWatch);
      const filters = Array.from(secretByYHex.keys());

      const resolved = new Set<string>();
      const { subId, unsubscribe } = await this.subs.subscribe<ProofStateNotification>(
        mintUrl,
        'proof_state',
        filters,
        (payload) =>
          this.runOwned(async () => {
            if (!isActive() || !['UNSPENT', 'PENDING', 'SPENT'].includes(payload.state)) return;
            const secret = secretByYHex.get(payload.Y);
            if (!secret || resolved.has(secret)) return;
            const key = toKey(mintUrl, secret);
            // Do not drop a terminal observation arriving while an earlier PENDING check runs.
            // Both WebSocket and polling transports may deliver a state change only once.
            const previous = this.processingByKey.get(key) ?? Promise.resolve();
            const work = previous
              .catch(() => {})
              .then(async () => {
                if (!isActive() || resolved.has(secret)) return;
                try {
                  const stored = await this.proofRepository.getProofBySecret(mintUrl, secret);
                  if (!isActive()) return;
                  if (stored?.state === 'pending') {
                    const changed = await this.transactionRunner.run((tx) =>
                      tx.perform(reconcileRestoredPending, {
                        mintUrl,
                        secret,
                        state: payload.state,
                      }),
                    );
                    if (changed) {
                      resolved.add(secret);
                      // Readiness listeners may spend this proof and create a new subscription.
                      // Finish the pending subscription's cleanup before publishing the change.
                      await this.stopWatching(key);
                      try {
                        await this.bus.emit(
                          'proofs:state-changed',
                          { mintUrl, secrets: [secret], state: changed.state },
                          { throwOnError: true, signal: eventSignal },
                        );
                      } catch (error) {
                        this.logger?.warn('Pending proof reconciled but event delivery failed', {
                          mintUrl,
                          error,
                        });
                      }
                    }
                    return;
                  }
                  if (stored?.state !== 'inflight' || payload.state !== 'SPENT') return;
                  const sendOperationId = this.sendOperationService
                    ? stored.usedByOperationId || stored.createdByOperationId
                    : undefined;
                  const handledBySend =
                    sendOperationId && this.sendOperationService
                      ? await this.sendOperationService.recordProofSpent(sendOperationId, secret)
                      : false;
                  if (!handledBySend) {
                    await this.proofs.setProofState(mintUrl, [secret], 'spent');
                  }
                  resolved.add(secret);
                  this.logger?.info('Marked inflight proof as spent from mint notification', {
                    mintUrl,
                  });
                  await this.stopWatching(key);
                } catch (err) {
                  this.logger?.error('Failed to mark inflight proof as spent', { mintUrl, err });
                }
              });
            this.processingByKey.set(key, work);
            try {
              await work;
            } finally {
              if (this.processingByKey.get(key) === work) this.processingByKey.delete(key);
            }
          }),
      );
      if (!isActive()) {
        await unsubscribe();
        return;
      }

      // Wrap a group unsubscribe to be idempotent
      let didUnsubscribe = false;
      const remaining = new Set(
        toWatch
          .filter((secret) => !resolved.has(secret))
          .map((secret) => yHexBySecret.get(secret)!),
      );
      const groupUnsubscribeOnce: UnsubscribeHandler = async () => {
        if (didUnsubscribe) return;
        didUnsubscribe = true;
        await unsubscribe();
        this.logger?.debug('Unsubscribed watcher for inflight proof group', { mintUrl, subId });
      };

      // For each secret, register a per-key stopper that shrinks the remaining set and
      // unsubscribes the group when the last filter is removed
      for (const secret of toWatch) {
        if (resolved.has(secret)) continue;
        const key = toKey(mintUrl, secret);
        const yHex = yHexBySecret.get(secret)!;
        const perKeyStop: UnsubscribeHandler = async () => {
          resolved.add(secret);
          if (remaining.has(yHex)) remaining.delete(yHex);
          if (remaining.size === 0) {
            await groupUnsubscribeOnce();
          }
        };
        this.watchByKey.set(key, { unsubscribe: perKeyStop, revision: 0 });
      }

      if (remaining.size === 0) await groupUnsubscribeOnce();
      this.logger?.debug('Watching inflight proof states', {
        mintUrl,
        subId,
        filterCount: filters.length,
      });
    } finally {
      for (const secret of toWatch) this.acquiringByKey.delete(toKey(mintUrl, secret));
    }
  }

  private async bootstrapInflightProofs(): Promise<void> {
    if (!this.running) return;
    this.logger?.info('Bootstrapping inflight proof watchers');

    await this.proofs.checkInflightProofs();
    if (!this.running) return;

    const inflightProofs = [
      ...(await this.proofRepository.getInflightProofs()),
      ...(await this.proofRepository.getPendingProofs()),
    ];
    if (!this.running || inflightProofs.length === 0) return;

    const byMint = new Map<string, string[]>();
    for (const proof of inflightProofs) {
      if (!proof.mintUrl || !proof.secret) continue;
      const secrets = byMint.get(proof.mintUrl) ?? [];
      secrets.push(proof.secret);
      byMint.set(proof.mintUrl, secrets);
    }

    for (const [mintUrl, secrets] of byMint.entries()) {
      if (!this.running) return;
      if (secrets.length === 0) continue;
      try {
        await this.watchProof(mintUrl, secrets);
      } catch (err) {
        this.logger?.warn('Failed to watch existing inflight proofs', {
          mintUrl,
          count: secrets.length,
          err,
        });
      }
    }
  }

  private async stopWatching(key: ProofKey, watch = this.watchByKey.get(key)): Promise<void> {
    if (!watch || this.watchByKey.get(key) !== watch) return;
    // Remove only this subscription, before awaiting transport cleanup or allowing replacement.
    this.watchByKey.delete(key);
    try {
      await watch.unsubscribe();
    } catch (err) {
      this.logger?.warn('Unsubscribe proof watcher failed', { key, err });
    }
  }

  async stopWatchingMint(mintUrl: string): Promise<void> {
    this.mintGeneration.set(mintUrl, (this.mintGeneration.get(mintUrl) ?? 0) + 1);
    this.logger?.info('Stopping all proof watchers for mint', { mintUrl });
    const prefix = `${mintUrl}::`;
    const keysToStop: ProofKey[] = [];

    for (const key of this.watchByKey.keys()) {
      if (key.startsWith(prefix)) {
        keysToStop.push(key);
      }
    }

    for (const key of keysToStop) {
      await this.stopWatching(key);
    }

    this.logger?.info('Stopped proof watchers for mint', { mintUrl, count: keysToStop.length });
  }

  /**
   * Resolve the send operation associated with a spent proof, if any.
   */
  private async getSendOperationIdForSpentProof(
    mintUrl: string,
    secret: string,
  ): Promise<string | undefined> {
    const spentProof = await this.proofRepository.getProofBySecret(mintUrl, secret);
    // Check both usedByOperationId (for exact match sends) and createdByOperationId (for swap sends)
    return spentProof?.usedByOperationId || spentProof?.createdByOperationId;
  }

  /**
   * Check if all send proofs for an operation are spent and finalize it if so.
   */
  private async tryFinalizeSendOperation(mintUrl: string, operationId: string): Promise<void> {
    if (!this.sendOperationService) return;

    try {
      const operation = await this.sendOperationService.getOperation(operationId);

      if (!operation || operation.state !== 'pending') return;

      // Operation must have prepared data to derive send secrets
      if (!hasPreparedData(operation)) return;

      // Derive send proof secrets from operation data
      const sendProofSecrets = getSendProofSecrets(operation);
      if (sendProofSecrets.length === 0) return;

      const sendProofs = await this.proofRepository.getProofsBySecrets(mintUrl, sendProofSecrets);
      const expectedProofCount = new Set(sendProofSecrets).size;
      const allSpent =
        sendProofs.length === expectedProofCount &&
        sendProofs.every((proof) => proof.state === 'spent');

      if (allSpent) {
        this.logger?.info('All send proofs spent, finalizing operation', { operationId });
        await this.sendOperationService.finalize(operationId);
      }
    } catch (err) {
      this.logger?.error('Failed to check/finalize send operation', { mintUrl, operationId, err });
    }
  }
}
