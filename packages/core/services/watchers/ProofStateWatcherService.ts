import type { EventBus, CoreEvents } from '@core/events';
import type { Logger } from '../../logging/Logger.ts';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import type { MintService } from '../MintService';
import type { ProofService } from '../ProofService';
import type { SendOperationService } from '../../operations/send/SendOperationService';
import {
  getSendProofSecrets,
  hasPreparedData,
  isLegacyTokenlessP2pkSend,
} from '../../operations/send/SendOperation';
import type { ProofRepository } from '../../repositories';
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
  /** Scan existing inflight proofs and pending Sends on start (default: true). */
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
  private stopping?: Promise<void>;
  private unsubscribeByKey = new Map<ProofKey, UnsubscribeHandler>();
  private inflightByKey = new Set<ProofKey>();
  private readonly acquiringKeys = new Set<ProofKey>();
  private offProofsStateChanged?: () => void;
  private offProofsSaved?: () => void;
  private offUntrusted?: () => void;
  private offSendPending?: () => void;
  private offSendFinalized?: () => void;
  private readonly ownedTasks = new Set<Promise<void>>();
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly sendOperationByProofKey = new Map<ProofKey, string>();

  constructor(
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
    this.logger?.info('ProofStateWatcherService started');

    // React to proofs being marked inflight via state change
    this.offProofsStateChanged = this.bus.on(
      'proofs:state-changed',
      ({ mintUrl, secrets, state }) =>
        this.runOwned(async () => {
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
          if (!this.running) return;
          const inflightSecrets = proofs.filter((p) => p.state === 'inflight').map((p) => p.secret);
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
          await this.stopWatchingMint(mintUrl);
        } catch (err) {
          this.logger?.error('Failed to stop watching mint proofs on untrust', { mintUrl, err });
        }
      }),
    );

    this.offSendPending = this.bus.on('send:pending', ({ operation }) => {
      // Send publishes while holding its operation lock. Run discovery after publication returns.
      if (!this.running) return;
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        void this.runOwned(() => this.discoverPendingSend(operation.id));
      }, 0);
      this.pendingTimers.add(timer);
    });

    this.offSendFinalized = this.bus.on('send:finalized', ({ operationId }) =>
      this.runOwned(async () => {
        for (const [key, owner] of this.sendOperationByProofKey) {
          if (owner !== operationId) continue;
          this.sendOperationByProofKey.delete(key);
          await this.stopWatching(key);
        }
      }),
    );

    if (this.options.watchExistingInflightOnStart ?? true) {
      void this.runOwned(() => this.bootstrapInflightProofs()).catch((err) => {
        this.logger?.warn('Failed to bootstrap inflight proof watchers', { err });
      });
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.running) return Promise.resolve();
    this.running = false;
    const task = this.finishStop();
    this.stopping = task;
    void task.then(
      () => {
        this.stopping = undefined;
      },
      () => {
        this.stopping = undefined;
      },
    );
    return task;
  }

  private async finishStop(): Promise<void> {
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

    this.offSendPending?.();
    this.offSendPending = undefined;
    this.offSendFinalized?.();
    this.offSendFinalized = undefined;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    while (this.ownedTasks.size > 0) {
      await Promise.allSettled(Array.from(this.ownedTasks));
    }
    this.sendOperationByProofKey.clear();

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

  private runOwned(work: () => Promise<void>): Promise<void> {
    if (!this.running) return Promise.resolve();
    const task = work();
    this.ownedTasks.add(task);
    void task.then(
      () => this.ownedTasks.delete(task),
      () => this.ownedTasks.delete(task),
    );
    return task;
  }

  watchProof(mintUrl: string, secrets: string[]): Promise<void> {
    return this.runOwned(() => this.acquireProofWatch(mintUrl, secrets));
  }

  private async acquireProofWatch(mintUrl: string, secrets: string[]): Promise<void> {
    if (!this.running) return;

    // Only watch proofs for trusted mints
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!this.running) return;
    if (!trusted) {
      this.logger?.debug('Skipping watch for untrusted mint', { mintUrl });
      return;
    }

    // Filter out secrets already being watched
    const unique = Array.from(new Set(secrets));
    const toWatch = unique.filter(
      (secret) =>
        !this.unsubscribeByKey.has(toKey(mintUrl, secret)) &&
        !this.acquiringKeys.has(toKey(mintUrl, secret)),
    );
    if (toWatch.length === 0) return;

    for (const secret of toWatch) this.acquiringKeys.add(toKey(mintUrl, secret));
    try {
      // Compute Y hex for all secrets and build maps
      const { secretByYHex, yHexBySecret } = buildYHexMapsForSecrets(toWatch);
      const filters = Array.from(secretByYHex.keys());

      const { subId, unsubscribe } = await this.subs.subscribe<ProofStateNotification>(
        mintUrl,
        'proof_state',
        filters,
        (payload) =>
          this.runOwned(async () => {
            if (payload.state !== 'SPENT') return;
            const secret = secretByYHex.get(payload.Y);
            if (!secret) return;
            const key = toKey(mintUrl, secret);
            if (this.inflightByKey.has(key)) return;
            this.inflightByKey.add(key);
            try {
              const sendOperationId = this.sendOperationService
                ? await this.getSendOperationIdForSpentProof(mintUrl, secret)
                : undefined;
              const handledBySend =
                sendOperationId && this.sendOperationService
                  ? await this.sendOperationService.recordProofSpent(sendOperationId, secret)
                  : false;
              if (!handledBySend) {
                await this.proofs.setProofState(mintUrl, [secret], 'spent');
              }
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
          }),
      );

      if (!this.running) {
        await unsubscribe();
        return;
      }

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
    } finally {
      for (const secret of toWatch) this.acquiringKeys.delete(toKey(mintUrl, secret));
    }
  }

  private async bootstrapInflightProofs(): Promise<void> {
    if (!this.running) return;
    this.logger?.info('Bootstrapping inflight proof watchers');

    if (this.sendOperationService) {
      try {
        const operations = await this.sendOperationService.getPendingOperations();
        for (const operation of operations) {
          if (!this.running) return;
          if (operation.state === 'pending') await this.discoverPendingSend(operation.id);
        }
      } catch (err) {
        this.logger?.warn('Failed to discover pending Sends on startup', { err });
      }
    }
    if (!this.running) return;
    await this.proofs.checkInflightProofs();
    if (!this.running) return;

    const inflightProofs = await this.proofRepository.getInflightProofs();
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

  async stopWatchingMint(mintUrl: string): Promise<void> {
    this.logger?.info('Stopping all proof watchers for mint', { mintUrl });
    const prefix = `${mintUrl}::`;
    const keysToStop: ProofKey[] = [];

    for (const key of this.unsubscribeByKey.keys()) {
      if (key.startsWith(prefix)) {
        keysToStop.push(key);
      }
    }

    // Also clear inflight tracking for this mint
    for (const key of this.inflightByKey) {
      if (key.startsWith(prefix)) {
        this.inflightByKey.delete(key);
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
    return (
      spentProof?.usedByOperationId ||
      spentProof?.createdByOperationId ||
      this.sendOperationByProofKey.get(toKey(mintUrl, secret))
    );
  }

  private async discoverPendingSend(operationId: string): Promise<void> {
    if (!this.running || !this.sendOperationService) return;
    try {
      const operation = await this.sendOperationService.getOperation(operationId);
      if (!this.running || operation?.state !== 'pending') return;
      const secrets = getSendProofSecrets(operation);
      if (isLegacyTokenlessP2pkSend(operation)) {
        if (!(await this.mintService.isTrustedMint(operation.mintUrl)) || !this.running) return;
        // Legacy tokenless sends may have no proof rows. The operation retains the exact outputs
        // needed for observation, and its service validates them when applying completion.
        await this.sendOperationService.checkPendingOperation(operation);
        if (!this.running) return;
        const latest = await this.sendOperationService.getOperation(operationId);
        if (!this.running || latest?.state !== 'pending') return;
        for (const secret of secrets) {
          this.sendOperationByProofKey.set(toKey(operation.mintUrl, secret), operationId);
        }
        await this.watchProof(operation.mintUrl, secrets);
      } else {
        await this.tryFinalizeSendOperation(operation.mintUrl, operationId);
      }
    } catch (err) {
      this.logger?.warn('Failed to discover pending Send', { operationId, err });
    }
  }

  /**
   * Check if all send proofs for an operation are spent and finalize it if so.
   */
  private async tryFinalizeSendOperation(mintUrl: string, operationId: string): Promise<void> {
    if (!this.running || !this.sendOperationService) return;

    try {
      const operation = await this.sendOperationService.getOperation(operationId);

      if (!this.running || !operation || operation.state !== 'pending') return;

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

      if (this.running && allSpent) {
        this.logger?.info('All send proofs spent, finalizing operation', { operationId });
        await this.sendOperationService.finalize(operationId);
      }
    } catch (err) {
      this.logger?.error('Failed to check/finalize send operation', { mintUrl, operationId, err });
    }
  }
}
