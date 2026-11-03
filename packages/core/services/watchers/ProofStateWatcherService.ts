import type { Proof, ProofState } from '@cashu/cashu-ts';
import type { EventBus, CoreEvents } from '@core/events';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { MintService } from '../MintService';
import type {
  SendOperationService,
  SendProofObservationTarget,
} from '../../operations/send/SendOperationService';
import { buildYHexMapsForSecrets } from '../../utils.ts';

type ProofKey = string;
function toKey(mintUrl: string, secret: string): ProofKey {
  return `${mintUrl}::${secret}`;
}

type ProofStateNotification = { Y: string; state: ProofState['state'] };

/** Remote proof-state checks for the startup scan; no Wallet persistence authority. */
export interface ProofStateRemote {
  checkProofStates(
    mintUrl: string,
    unit: string,
    proofs: Pick<Proof, 'id' | 'secret'>[],
  ): Promise<ProofState[]>;
}

export interface ProofStateWatcherOptions {
  /** Scan pending Sends and their proof observations on start (default: true). */
  watchExistingInflightOnStart?: boolean;
}

export class ProofStateWatcherService {
  private running = false;
  private started = false;
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
  private readonly targetsByProofKey = new Map<ProofKey, SendProofObservationTarget>();
  private readonly options: ProofStateWatcherOptions;

  constructor(
    private readonly subs: SubscriptionManager,
    private readonly mintService: Pick<MintService, 'isTrustedMint'>,
    private readonly sendOperationService: Pick<
      SendOperationService,
      | 'getPendingOperations'
      | 'getProofObservationTargets'
      | 'advancePendingOperation'
      | 'applyProofStateObservation'
    >,
    private readonly remote: ProofStateRemote,
    private readonly bus: EventBus<CoreEvents>,
    private readonly logger?: Logger,
    options: ProofStateWatcherOptions = { watchExistingInflightOnStart: true },
  ) {
    this.options = { ...options };
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.started || this.stopping) return;
    this.started = true;
    this.running = true;
    this.offProofsStateChanged = this.bus.on(
      'proofs:state-changed',
      ({ mintUrl, secrets, state }) =>
        this.runIfActive(async () => {
          try {
            if (state === 'inflight') await this.watchProof(mintUrl, secrets);
            else if (state === 'spent') {
              const targets = await this.sendOperationService.getProofObservationTargets({
                mintUrl,
                secrets,
              });
              if (!this.running) return;
              const operationIds = new Set(targets.map((target) => target.operationId));
              for (const secret of secrets) {
                if (!this.running) return;
                const key = toKey(mintUrl, secret);
                const target = this.targetsByProofKey.get(key);
                if (target) operationIds.add(target.operationId);
                await this.stopWatching(key);
              }
              for (const id of operationIds) {
                if (!this.running) return;
                await this.sendOperationService.advancePendingOperation(id);
              }
            }
          } catch (err) {
            this.logger?.warn('Failed to handle proof observation targets', { mintUrl, err });
          }
        }),
    );
    this.offProofsSaved = this.bus.on('proofs:saved', ({ mintUrl, proofs }) =>
      this.runIfActive(async () => {
        try {
          await this.watchProof(
            mintUrl,
            proofs.filter((proof) => proof.state === 'inflight').map((proof) => proof.secret),
          );
        } catch (err) {
          this.logger?.warn('Failed to observe saved Send proofs', { mintUrl, err });
        }
      }),
    );
    this.offUntrusted = this.bus.on('mint:untrusted', ({ mintUrl }) =>
      this.runIfActive(() => this.stopWatchingMint(mintUrl)),
    );
    this.offSendPending = this.bus.on('send:pending', ({ operation }) => {
      // Send publishes while holding its operation lock. Discovery runs after publication returns.
      if (!this.running) return;
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        void this.runIfActive(() => this.discoverPendingSend(operation.id));
      }, 0);
      this.pendingTimers.add(timer);
    });
    this.offSendFinalized = this.bus.on('send:finalized', ({ operationId }) =>
      this.runIfActive(async () => {
        for (const [key, target] of this.targetsByProofKey) {
          if (!this.running) return;
          if (target.operationId !== operationId) continue;
          this.targetsByProofKey.delete(key);
          await this.stopWatching(key);
        }
      }),
    );
    if (this.options.watchExistingInflightOnStart ?? true) {
      void this.runIfActive(() => this.bootstrapInflightProofs()).catch((err) => {
        this.logger?.warn('Failed to discover pending Send observations', { err });
      });
    }
  }

  /**
   * Stop accepting work and release subscriptions, including acquisitions already in progress.
   * Started operation checks and notification processing may finish and publish events afterward;
   * awaiting them here would deadlock an event listener that awaits stop().
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    const task = this.finishStop();
    this.stopping = task;
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
    this.targetsByProofKey.clear();

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

  private runIfActive(work: () => Promise<void>): Promise<void> {
    return this.running ? work() : Promise.resolve();
  }

  async watchProof(mintUrl: string, secrets: string[]): Promise<void> {
    if (!this.running || secrets.length === 0) return;
    const targets = await this.sendOperationService.getProofObservationTargets({
      mintUrl,
      secrets,
    });
    if (this.running) await this.watchTargets(targets);
  }

  private watchTargets(targets: SendProofObservationTarget[]): Promise<void> {
    if (!this.running || targets.length === 0) return Promise.resolve();
    const task = this.acquireProofWatch(targets);
    this.acquisitionTasks.add(task);
    void task.then(
      () => this.acquisitionTasks.delete(task),
      () => this.acquisitionTasks.delete(task),
    );
    return task;
  }

  private async acquireProofWatch(targets: SendProofObservationTarget[]): Promise<void> {
    const mintUrl = targets[0]!.mintUrl;
    if (!(await this.mintService.isTrustedMint(mintUrl)) || !this.running) return;
    const watchable = targets.filter(
      (target) =>
        target.state === 'inflight' &&
        !this.unsubscribeByKey.has(toKey(mintUrl, target.secret)) &&
        !this.acquiringKeys.has(toKey(mintUrl, target.secret)),
    );
    if (watchable.length === 0) return;
    for (const target of watchable) {
      const key = toKey(mintUrl, target.secret);
      this.acquiringKeys.add(key);
      this.targetsByProofKey.set(key, target);
    }
    try {
      const { secretByYHex, yHexBySecret } = buildYHexMapsForSecrets(
        watchable.map((target) => target.secret),
      );
      const filters = [...secretByYHex.keys()];
      const { unsubscribe } = await this.subs.subscribe<ProofStateNotification>(
        mintUrl,
        'proof_state',
        filters,
        (payload) =>
          this.runIfActive(async () => {
            if (payload.state !== 'SPENT') return;
            const secret = secretByYHex.get(payload.Y);
            if (!secret) return;
            const key = toKey(mintUrl, secret);
            const target = this.targetsByProofKey.get(key);
            if (!target || this.inflightByKey.has(key)) return;
            this.inflightByKey.add(key);
            try {
              await this.sendOperationService.applyProofStateObservation(target.operationId, [
                secret,
              ]);
              if (this.running) await this.stopWatching(key);
            } catch (err) {
              this.logger?.warn('Failed to apply Send proof observation', {
                operationId: target.operationId,
                mintUrl,
                err,
              });
            } finally {
              this.inflightByKey.delete(key);
            }
          }),
      );
      const active = watchable.filter(
        (target) => this.targetsByProofKey.get(toKey(mintUrl, target.secret)) === target,
      );
      if (!this.running || active.length === 0) {
        await unsubscribe();
        return;
      }
      let unsubscribing: Promise<void> | undefined;
      const remaining = new Set(active.map((target) => yHexBySecret.get(target.secret)!));
      const unsubscribeOnce = () => (unsubscribing ??= unsubscribe());
      for (const target of active) {
        const key = toKey(mintUrl, target.secret);
        const y = yHexBySecret.get(target.secret)!;
        this.unsubscribeByKey.set(key, async () => {
          remaining.delete(y);
          if (remaining.size === 0) await unsubscribeOnce();
        });
      }
    } finally {
      for (const target of watchable) this.acquiringKeys.delete(toKey(mintUrl, target.secret));
    }
  }

  private async discoverPendingSend(operationId: string): Promise<void> {
    try {
      await this.sendOperationService.advancePendingOperation(operationId);
      if (!this.running) return;
      const targets = await this.sendOperationService.getProofObservationTargets(operationId);
      if (this.running) await this.watchTargets(targets);
    } catch (err) {
      this.logger?.warn('Failed to discover pending Send', { operationId, err });
    }
  }

  private async bootstrapInflightProofs(): Promise<void> {
    const operations = await this.sendOperationService.getPendingOperations();
    if (!this.running) return;
    // Reassess locally completed and legacy Sends without delaying the batched proof-state scan.
    await Promise.all([
      (async () => {
        for (const operation of operations) {
          if (!this.running) return;
          await this.discoverPendingSend(operation.id);
        }
      })(),
      this.checkExistingProofs(operations.map((operation) => operation.id)),
    ]);
  }

  private async checkExistingProofs(operationIds: string[]): Promise<void> {
    const batches = new Map<string, SendProofObservationTarget[]>();
    for (const operationId of operationIds) {
      const targets = await this.sendOperationService.getProofObservationTargets(operationId);
      if (!this.running) return;
      for (const target of targets) {
        if (target.state !== 'inflight') continue;
        const key = `${target.mintUrl}::${target.unit}`;
        const batch = batches.get(key) ?? [];
        batch.push(target);
        batches.set(key, batch);
      }
    }
    for (const targets of batches.values()) {
      if (!this.running) return;
      const { mintUrl, unit } = targets[0]!;
      if (!(await this.mintService.isTrustedMint(mintUrl)) || !this.running) continue;
      try {
        const states = await this.remote.checkProofStates(mintUrl, unit, targets);
        if (!this.running) return;
        if (!Array.isArray(states) || states.length !== targets.length) {
          throw new Error('Malformed proof state check response');
        }
        const spentBySend = new Map<string, string[]>();
        for (const [index, target] of targets.entries()) {
          if (states[index]?.state !== 'SPENT') continue;
          const secrets = spentBySend.get(target.operationId) ?? [];
          secrets.push(target.secret);
          spentBySend.set(target.operationId, secrets);
        }
        for (const [operationId, secrets] of spentBySend) {
          if (!this.running) return;
          try {
            await this.sendOperationService.applyProofStateObservation(operationId, secrets);
          } catch (err) {
            this.logger?.warn('Failed to apply startup Send proof observations', {
              operationId,
              mintUrl,
              err,
            });
          }
        }
      } catch (err) {
        this.logger?.warn('Failed to check Send proofs', { mintUrl, unit, err });
      }
    }
  }

  private async stopWatching(key: ProofKey): Promise<void> {
    this.targetsByProofKey.delete(key);
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
    this.logger?.info('Stopping all proof watchers for mint', { mintUrl });
    const prefix = `${mintUrl}::`;
    const keysToStop: ProofKey[] = [];

    // Revoke targets before waiting for cleanup, including targets whose acquisition is pending.
    for (const [key, target] of this.targetsByProofKey) {
      if (target.mintUrl === mintUrl) this.targetsByProofKey.delete(key);
    }

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
}
