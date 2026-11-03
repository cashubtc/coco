import type { ProofState } from '@cashu/cashu-ts';
import { DEFAULT_UNIT, normalizeUnit } from '@core/amounts.ts';
import type { EventBus, CoreEvents } from '@core/events';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import {
  resolveOwningOperation,
  type OwningOperation,
  type OwningOperationCache,
  type OwningOperationReads,
} from '@core/proofs/OwningOperation.ts';
import type { CoreTransactionRunner } from '@core/transactions/CoreTransaction.ts';
import type { CoreProof } from '@core/types.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { MintService } from '../MintService';
import type { SendOperationService } from '../../operations/send/SendOperationService';
import { recordUnownedProofsSpent } from '../../operations/proofs/ProofReconciliationTransitions.ts';
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

/** Remote proof-state checks for the startup scan. It has no Wallet persistence authority. */
export interface ProofStateRemote {
  checkProofStates(mintUrl: string, unit: string, proofs: CoreProof[]): Promise<ProofState[]>;
}

/**
 * Where the watcher routes evidence for a proof: to its live Owning Operation, or to its own
 * reconciliation when the proof is unowned. Only unowned and Send-owned proofs are watched; Melt and
 * other live owners observe their proofs themselves.
 */
type EvidenceRoute = { kind: 'unowned' } | OwningOperation;

type WatchableRoute = Extract<EvidenceRoute, { kind: 'unowned' | 'send' }>;

type WatchableProof = { proof: CoreProof; route: WatchableRoute };

function isWatchable(route: EvidenceRoute | undefined): route is WatchableRoute {
  return route?.kind === 'unowned' || route?.kind === 'send';
}

type ProofReads = Pick<
  ProofRepository,
  'getInflightProofs' | 'getProofBySecret' | 'getProofsBySecrets'
>;

export interface ProofStateWatcherOptions {
  /** Scan existing inflight proofs and pending Sends on start (default: true). */
  watchExistingInflightOnStart?: boolean;
}

export class ProofStateWatcherService {
  private readonly subs: SubscriptionManager;
  private readonly mintService: MintService;
  private readonly proofRepository: ProofReads;
  private readonly operations: OwningOperationReads;
  private readonly transactionRunner: CoreTransactionRunner;
  private readonly remote: ProofStateRemote;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly options: ProofStateWatcherOptions;
  private sendOperationService?: SendOperationService;

  private running = false;
  private generation = 0;
  private stopping?: Promise<void>;
  private unsubscribeByKey = new Map<ProofKey, UnsubscribeHandler>();
  private inflightByKey = new Set<ProofKey>();
  private readonly acquiringKeys = new Set<ProofKey>();
  private offProofsStateChanged?: () => void;
  private offProofsSaved?: () => void;
  private offUntrusted?: () => void;
  private offSendPending?: () => void;
  private offSendFinalized?: () => void;
  private readonly acquisitionTasks = new Set<Promise<void>>();
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly sendOperationByProofKey = new Map<ProofKey, string>();

  constructor(
    subs: SubscriptionManager,
    mintService: MintService,
    proofRepository: ProofReads,
    operations: OwningOperationReads,
    transactionRunner: CoreTransactionRunner,
    remote: ProofStateRemote,
    bus: EventBus<CoreEvents>,
    logger?: Logger,
    options: ProofStateWatcherOptions = { watchExistingInflightOnStart: true },
  ) {
    this.subs = subs;
    this.mintService = mintService;
    this.proofRepository = proofRepository;
    this.operations = operations;
    this.transactionRunner = transactionRunner;
    this.remote = remote;
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
    const generation = ++this.generation;
    this.logger?.info('ProofStateWatcherService started');

    // React to proofs being marked inflight via state change
    this.offProofsStateChanged = this.bus.on(
      'proofs:state-changed',
      ({ mintUrl, secrets, state }) =>
        this.runIfActive(generation, async () => {
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
                if (!this.isActive(generation)) return;
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

                if (!this.isActive(generation)) return;
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
                await this.tryFinalizeSendOperation(mintUrl, operationId, generation);
              }
            }
          } catch (err) {
            this.logger?.error('Error handling proofs:state-changed', { err });
          }
        }),
    );

    // React to proofs being saved with inflight state (e.g., from swap operations)
    this.offProofsSaved = this.bus.on('proofs:saved', ({ mintUrl, proofs }) =>
      this.runIfActive(generation, async () => {
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
      this.runIfActive(generation, async () => {
        try {
          await this.stopWatchingMint(mintUrl);
        } catch (err) {
          this.logger?.error('Failed to stop watching mint proofs on untrust', { mintUrl, err });
        }
      }),
    );

    this.offSendPending = this.bus.on('send:pending', ({ operation }) => {
      // Send publishes while holding its operation lock. Run discovery after publication returns.
      if (!this.isActive(generation)) return;
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        void this.runIfActive(generation, () => this.discoverPendingSend(operation.id, generation));
      }, 0);
      this.pendingTimers.add(timer);
    });

    this.offSendFinalized = this.bus.on('send:finalized', ({ operationId }) =>
      this.runIfActive(generation, async () => {
        for (const [key, sendOperationId] of this.sendOperationByProofKey) {
          if (!this.isActive(generation)) return;
          if (sendOperationId !== operationId) continue;
          this.sendOperationByProofKey.delete(key);
          await this.stopWatching(key);
        }
      }),
    );

    if (this.options.watchExistingInflightOnStart ?? true) {
      void this.runIfActive(generation, () => this.bootstrapInflightProofs(generation)).catch(
        (err) => {
          this.logger?.warn('Failed to bootstrap inflight proof watchers', { err });
        },
      );
    }
  }

  /**
   * Stop accepting work and release subscriptions, including acquisitions already in progress.
   * Started operation checks and notification processing may finish and publish events afterward;
   * awaiting them here would deadlock an event listener that awaits stop().
   */
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
    while (this.acquisitionTasks.size > 0) {
      await Promise.allSettled(Array.from(this.acquisitionTasks));
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

  private isActive(generation: number): boolean {
    return this.running && this.generation === generation;
  }

  private runIfActive(generation: number, work: () => Promise<void>): Promise<void> {
    return this.isActive(generation) ? work() : Promise.resolve();
  }

  watchProof(mintUrl: string, secrets: string[]): Promise<void> {
    return this.watchProofs(mintUrl, secrets, new Map());
  }

  private watchProofs(
    mintUrl: string,
    secrets: string[],
    owningOperations: OwningOperationCache,
  ): Promise<void> {
    if (!this.running) return Promise.resolve();
    const task = this.acquireProofWatch(mintUrl, secrets, this.generation, owningOperations);
    this.acquisitionTasks.add(task);
    void task.then(
      () => this.acquisitionTasks.delete(task),
      () => this.acquisitionTasks.delete(task),
    );
    return task;
  }

  private async acquireProofWatch(
    mintUrl: string,
    secrets: string[],
    generation: number,
    owningOperations: OwningOperationCache,
  ): Promise<void> {
    if (!this.isActive(generation)) return;

    // Only watch proofs for trusted mints
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!this.isActive(generation)) return;
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
      const watchable = await this.selectWatchable(mintUrl, toWatch, owningOperations);
      if (!this.isActive(generation) || watchable.length === 0) return;
      // Compute Y hex for all secrets and build maps
      const { secretByYHex, yHexBySecret } = buildYHexMapsForSecrets(watchable);
      const filters = Array.from(secretByYHex.keys());

      const { subId, unsubscribe } = await this.subs.subscribe<ProofStateNotification>(
        mintUrl,
        'proof_state',
        filters,
        (payload) =>
          this.runIfActive(generation, async () => {
            if (payload.state !== 'SPENT') return;
            const secret = secretByYHex.get(payload.Y);
            if (!secret) return;
            const key = toKey(mintUrl, secret);
            if (this.inflightByKey.has(key)) return;
            this.inflightByKey.add(key);
            try {
              const [proof] = await this.proofRepository.getProofsBySecrets(mintUrl, [secret]);
              const route = await this.resolveRoute(mintUrl, secret, proof);
              if (!this.isActive(generation)) return;
              await this.applySpentEvidence(mintUrl, secret, route);
              this.logger?.info('Applied SPENT evidence from mint notification', {
                mintUrl,
                subId,
                route: route?.kind,
              });
              if (this.isActive(generation)) await this.stopWatching(key);
            } catch (err) {
              this.logger?.error('Failed to apply SPENT evidence', { mintUrl, subId, err });
            } finally {
              if (generation === this.generation) this.inflightByKey.delete(key);
            }
          }),
      );

      if (!this.isActive(generation)) {
        await unsubscribe();
        return;
      }

      // Share completion as well as invocation, so stop() also waits for cleanup already underway.
      let unsubscribing: Promise<void> | undefined;
      const remaining = new Set(filters);
      const groupUnsubscribeOnce: UnsubscribeHandler = () => {
        unsubscribing ??= (async () => {
          await unsubscribe();
          this.logger?.debug('Unsubscribed watcher for inflight proof group', { mintUrl, subId });
        })();
        return unsubscribing;
      };

      // For each secret, register a per-key stopper that shrinks the remaining set and
      // unsubscribes the group when the last filter is removed
      for (const secret of watchable) {
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

  private async bootstrapInflightProofs(generation: number): Promise<void> {
    if (!this.isActive(generation)) return;
    this.logger?.info('Bootstrapping inflight proof watchers');

    // Send discovery may contact the mint per operation; do not delay inflight proof observation.
    await Promise.all([
      this.discoverPendingSends(generation),
      this.watchExistingInflightProofs(generation),
    ]);
  }

  private async discoverPendingSends(generation: number): Promise<void> {
    if (!this.sendOperationService) return;
    try {
      const operations = await this.sendOperationService.getPendingOperations();
      for (const operation of operations) {
        if (!this.isActive(generation)) return;
        if (operation.state === 'pending') await this.discoverPendingSend(operation.id, generation);
      }
    } catch (err) {
      this.logger?.warn('Failed to discover pending Sends on startup', { err });
    }
  }

  /**
   * Check inflight proofs once, then watch those still eligible. SPENT evidence for Send-owned
   * proofs goes to the Send; unowned proofs, including those whose referenced operations are missing
   * or terminal, are reconciled; proofs other live operations own are skipped.
   */
  private async watchExistingInflightProofs(generation: number): Promise<void> {
    const inflightProofs = await this.proofRepository.getInflightProofs();
    if (!this.isActive(generation) || inflightProofs.length === 0) return;

    const owningOperations: OwningOperationCache = new Map();
    const batches = new Map<string, { mintUrl: string; unit: string; proofs: WatchableProof[] }>();
    const byMint = new Map<string, string[]>();
    for (const proof of inflightProofs) {
      if (!proof.mintUrl || !proof.secret) continue;
      const route = await this.resolveRoute(proof.mintUrl, proof.secret, proof, owningOperations);
      if (!this.isActive(generation)) return;
      if (!isWatchable(route)) continue;
      const unit = normalizeUnit(proof.unit, { defaultUnit: DEFAULT_UNIT });
      const batchKey = `${proof.mintUrl}::${unit}`;
      const batch = batches.get(batchKey) ?? { mintUrl: proof.mintUrl, unit, proofs: [] };
      batch.proofs.push({ proof, route });
      batches.set(batchKey, batch);
      const secrets = byMint.get(proof.mintUrl) ?? [];
      secrets.push(proof.secret);
      byMint.set(proof.mintUrl, secrets);
    }

    for (const { mintUrl, unit, proofs } of batches.values()) {
      if (!this.isActive(generation)) return;
      try {
        await this.checkExistingProofs(mintUrl, unit, proofs, generation);
      } catch (err) {
        this.logger?.warn('Failed to check inflight proofs for mint', {
          mintUrl,
          unit,
          count: proofs.length,
          err,
        });
      }
    }

    for (const [mintUrl, secrets] of byMint.entries()) {
      if (!this.isActive(generation)) return;
      try {
        // Rereads proof state, since the check above may have reconciled some proofs.
        await this.watchProofs(mintUrl, secrets, owningOperations);
      } catch (err) {
        this.logger?.warn('Failed to watch existing inflight proofs', {
          mintUrl,
          count: secrets.length,
          err,
        });
      }
    }
  }

  private async checkExistingProofs(
    mintUrl: string,
    unit: string,
    proofs: WatchableProof[],
    generation: number,
  ): Promise<void> {
    if (!(await this.mintService.isTrustedMint(mintUrl)) || !this.isActive(generation)) return;
    const states = await this.remote.checkProofStates(
      mintUrl,
      unit,
      proofs.map(({ proof }) => proof),
    );
    if (!this.isActive(generation)) return;
    if (!Array.isArray(states) || states.length !== proofs.length) {
      this.logger?.warn('Malformed proof state check response', {
        mintUrl,
        expected: proofs.length,
        received: (states as { length?: number } | null | undefined)?.length ?? 0,
      });
      return;
    }
    const spent = proofs.filter((_proof, index) => states[index]?.state === 'SPENT');
    const unowned = spent.filter(({ route }) => route.kind === 'unowned');
    if (unowned.length > 0) {
      await this.recordUnownedSpent(
        mintUrl,
        unowned.map(({ proof }) => proof.secret),
      );
    }
    for (const { proof, route } of spent) {
      if (route.kind !== 'send' || !this.isActive(generation)) continue;
      try {
        await this.applySpentEvidence(mintUrl, proof.secret, route);
      } catch (err) {
        this.logger?.warn('Send could not apply SPENT evidence', {
          mintUrl,
          operationId: route.operationId,
          err,
        });
      }
    }
  }

  /**
   * Hand SPENT evidence to the proof's Owning Operation, or reconcile it when no operation owns it.
   * A Send that declines or fails keeps its proofs; the watcher never writes them directly. Melt
   * observes its own proofs; any other live owner keeps the proof untouched.
   */
  private async applySpentEvidence(
    mintUrl: string,
    secret: string,
    route: EvidenceRoute | undefined,
  ): Promise<void> {
    if (route?.kind === 'unowned') {
      await this.recordUnownedSpent(mintUrl, [secret]);
    } else if (route?.kind === 'send') {
      if (!this.sendOperationService) return;
      const handled = await this.sendOperationService.recordProofSpent(route.operationId, secret);
      if (!handled) {
        this.logger?.debug('Send declined SPENT evidence', {
          mintUrl,
          operationId: route.operationId,
        });
      }
    } else if (route && route.kind !== 'melt') {
      this.logger?.warn('Left SPENT evidence for a proof another live operation owns', {
        mintUrl,
        operationKind: route.kind,
        operationId: route.operationId,
      });
    }
  }

  /** Reconciliation for unowned proofs; the transition rechecks ownership and state in scope. */
  private async recordUnownedSpent(mintUrl: string, secrets: string[]): Promise<void> {
    const result = await this.transactionRunner.run((tx) =>
      tx.perform(recordUnownedProofsSpent, { mintUrl, secrets }),
    );
    if (result.spentSecrets.length === 0) return;
    this.logger?.info('Marked unowned inflight proofs as spent', {
      mintUrl: result.mintUrl,
      count: result.spentSecrets.length,
    });
    try {
      await this.bus.emit(
        'proofs:state-changed',
        { mintUrl: result.mintUrl, secrets: result.spentSecrets, state: 'spent' },
        { throwOnError: true },
      );
    } catch (err) {
      this.logger?.error('Failed to publish reconciled proof states', { mintUrl, err });
    }
  }

  /** Keep inflight proofs the watcher may act on: unowned, Send-owned or legacy Send outputs. */
  private async selectWatchable(
    mintUrl: string,
    secrets: string[],
    owningOperations: OwningOperationCache,
  ): Promise<string[]> {
    const stored = new Map(
      (await this.proofRepository.getProofsBySecrets(mintUrl, secrets)).map((proof) => [
        proof.secret,
        proof,
      ]),
    );
    const watchable: string[] = [];
    for (const secret of secrets) {
      const proof = stored.get(secret);
      if (proof && proof.state !== 'inflight') continue;
      if (isWatchable(await this.resolveRoute(mintUrl, secret, proof, owningOperations))) {
        watchable.push(secret);
      }
    }
    return watchable;
  }

  /**
   * Resolve where evidence for a proof goes from its record's live Owning Operation. Without one,
   * outputs discovered for a legacy tokenless Send still go to that Send.
   */
  private async resolveRoute(
    mintUrl: string,
    secret: string,
    proof: CoreProof | null | undefined,
    owningOperations: OwningOperationCache = new Map(),
  ): Promise<EvidenceRoute | undefined> {
    const owningOperation =
      proof && (await resolveOwningOperation(this.operations, proof, owningOperations));
    if (owningOperation) return owningOperation;
    const legacySendId = this.sendOperationByProofKey.get(toKey(mintUrl, secret));
    if (legacySendId) return { kind: 'send', operationId: legacySendId };
    return proof ? { kind: 'unowned' } : undefined;
  }

  private async stopWatching(key: ProofKey): Promise<void> {
    const unsubscribe = this.unsubscribeByKey.get(key);
    if (!unsubscribe) return;
    try {
      await unsubscribe();
    } catch (err) {
      this.logger?.warn('Unsubscribe proof watcher failed', { key, err });
    } finally {
      if (this.unsubscribeByKey.get(key) === unsubscribe) this.unsubscribeByKey.delete(key);
    }
  }

  async stopWatchingMint(mintUrl: string): Promise<void> {
    const generation = this.generation;
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
      if (generation !== this.generation) return;
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

  private async discoverPendingSend(operationId: string, generation: number): Promise<void> {
    if (!this.isActive(generation) || !this.sendOperationService) return;
    try {
      const operation = await this.sendOperationService.getOperation(operationId);
      if (!this.isActive(generation) || operation?.state !== 'pending') return;
      const secrets = getSendProofSecrets(operation);
      if (isLegacyTokenlessP2pkSend(operation)) {
        if (
          !(await this.mintService.isTrustedMint(operation.mintUrl)) ||
          !this.isActive(generation)
        )
          return;
        // Legacy tokenless sends may have no proof rows. The operation retains the exact outputs
        // needed for observation, and its service validates them when applying completion.
        await this.sendOperationService.checkPendingOperation(operation);
        if (!this.isActive(generation)) return;
        const latest = await this.sendOperationService.getOperation(operationId);
        if (!this.isActive(generation) || latest?.state !== 'pending') return;
        for (const secret of secrets) {
          this.sendOperationByProofKey.set(toKey(operation.mintUrl, secret), operationId);
        }
        await this.watchProof(operation.mintUrl, secrets);
      } else {
        await this.tryFinalizeSendOperation(operation.mintUrl, operationId, generation);
      }
    } catch (err) {
      this.logger?.warn('Failed to discover pending Send', { operationId, err });
    }
  }

  /**
   * Check if all send proofs for an operation are spent and finalize it if so.
   */
  private async tryFinalizeSendOperation(
    mintUrl: string,
    operationId: string,
    generation: number,
  ): Promise<void> {
    if (!this.isActive(generation) || !this.sendOperationService) return;

    try {
      const operation = await this.sendOperationService.getOperation(operationId);

      if (!this.isActive(generation) || !operation || operation.state !== 'pending') return;

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

      if (this.isActive(generation) && allSpent) {
        this.logger?.info('All send proofs spent, finalizing operation', { operationId });
        await this.sendOperationService.finalize(operationId);
      }
    } catch (err) {
      this.logger?.error('Failed to check/finalize send operation', { mintUrl, operationId, err });
    }
  }
}
