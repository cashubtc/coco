import { Effect } from 'effect';
import type { EventBus, CoreEvents } from '@core/events';
import type { Logger } from '../../logging/Logger.ts';
import type { SubscriptionManager, UnsubscribeHandler } from '@core/infra/SubscriptionManager.ts';
import type { MintService } from '../MintService';
import type { ProofService } from '../ProofService';
import type { SendOperationService } from '../../operations/send/SendOperationService';
import { getSendProofSecrets, hasPreparedData } from '../../operations/send/SendOperation';
import type { ProofRepository } from '../../repositories';
import { buildYHexMapsForSecrets } from '../../utils.ts';
import { BackgroundTaskRuntime, uninterruptiblePromise } from './BackgroundTaskRuntime.ts';

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
  // Scan existing inflight proofs on start.
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

  private runtime?: BackgroundTaskRuntime;
  private unsubscribeByKey = new Map<ProofKey, UnsubscribeHandler>();
  private inflightByKey = new Set<ProofKey>();

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
    return this.runtime?.isActive ?? false;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;

    const runtime = BackgroundTaskRuntime.make();
    this.runtime = runtime;
    try {
      runtime.addFinalizer(
        this.bus.on('proofs:state-changed', (event) =>
          this.runTask(
            runtime,
            () => this.handleProofStateChanged(runtime, event),
            (err) => this.logger?.error('Error handling proofs:state-changed', { err }),
          ),
        ),
      );
      runtime.addFinalizer(
        this.bus.on('proofs:saved', (event) =>
          this.runTask(
            runtime,
            () => this.handleProofsSaved(runtime, event),
            (err) => this.logger?.error('Error handling proofs:saved', { err }),
          ),
        ),
      );
      runtime.addFinalizer(
        this.bus.on('mint:untrusted', ({ mintUrl }) =>
          this.runTask(
            runtime,
            () => this.stopWatchingMint(mintUrl),
            (err) =>
              this.logger?.error('Failed to stop watching mint proofs on untrust', {
                mintUrl,
                err,
              }),
          ),
        ),
      );

      if (this.options.watchExistingInflightOnStart) {
        void this.runTask(
          runtime,
          () => this.bootstrapInflightProofs(runtime),
          (err) => this.logger?.warn('Failed to bootstrap inflight proof watchers', { err }),
        );
      }

      this.logger?.info('ProofStateWatcherService started');
    } catch (error) {
      this.runtime = undefined;
      await runtime.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    this.runtime = undefined;

    await runtime.close();
    this.unsubscribeByKey.clear();
    this.inflightByKey.clear();
    this.logger?.info('ProofStateWatcherService stopped');
  }

  private runTask(
    runtime: BackgroundTaskRuntime,
    task: () => Promise<void>,
    onError: (error: unknown) => void,
  ): Promise<void> {
    if (this.runtime !== runtime) return Promise.resolve();

    return runtime.run(
      uninterruptiblePromise(task).pipe(
        Effect.catchAll((error) => Effect.sync(() => onError(error))),
      ),
    );
  }

  private async handleProofStateChanged(
    runtime: BackgroundTaskRuntime,
    { mintUrl, secrets, state }: CoreEvents['proofs:state-changed'],
  ): Promise<void> {
    if (this.runtime !== runtime) return;

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
      return;
    }

    if (state !== 'spent') return;

    const operationIds = new Set<string>();
    for (const secret of secrets) {
      const key = toKey(mintUrl, secret);
      try {
        await this.stopWatching(key);
      } catch (err) {
        this.logger?.warn('Failed to stop watcher on spent proof', { mintUrl, secret, err });
      }

      if (!this.sendOperationService) continue;

      try {
        const operationId = await this.getSendOperationIdForSpentProof(mintUrl, secret);
        if (operationId) operationIds.add(operationId);
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

  private async handleProofsSaved(
    runtime: BackgroundTaskRuntime,
    { mintUrl, proofs }: CoreEvents['proofs:saved'],
  ): Promise<void> {
    if (this.runtime !== runtime) return;

    const inflightSecrets = proofs
      .filter((proof) => proof.state === 'inflight')
      .map((p) => p.secret);
    if (inflightSecrets.length === 0) return;

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

  async watchProof(mintUrl: string, secrets: string[]): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isActive) return;

    // Only watch proofs for trusted mints
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (this.runtime !== runtime) return;
    if (!trusted) {
      this.logger?.debug('Skipping watch for untrusted mint', { mintUrl });
      return;
    }

    // Filter out secrets already being watched
    const unique = Array.from(new Set(secrets));
    const toWatch = unique.filter((secret) => !this.unsubscribeByKey.has(toKey(mintUrl, secret)));
    if (toWatch.length === 0) return;

    // Compute Y hex for all secrets and build maps
    const { secretByYHex, yHexBySecret } = buildYHexMapsForSecrets(toWatch);
    const filters = Array.from(secretByYHex.keys());

    let callbackSubId: string | undefined;
    const { subId, unsubscribe } = await this.subs.subscribe<ProofStateNotification>(
      mintUrl,
      'proof_state',
      filters,
      (payload) =>
        this.runTask(
          runtime,
          () => this.handleProofStateNotification(mintUrl, callbackSubId, secretByYHex, payload),
          (err) =>
            this.logger?.error('Error handling proof state notification', {
              mintUrl,
              subId: callbackSubId,
              err,
            }),
        ),
    );
    callbackSubId = subId;

    // Wrap a group unsubscribe to be idempotent
    let didUnsubscribe = false;
    const remaining = new Set(filters);
    const groupUnsubscribeOnce: UnsubscribeHandler = async () => {
      if (didUnsubscribe) return;
      didUnsubscribe = true;
      await unsubscribe();
      this.logger?.debug('Unsubscribed watcher for inflight proof group', { mintUrl, subId });
    };

    if (this.runtime !== runtime) {
      await groupUnsubscribeOnce();
      return;
    }
    runtime.addFinalizer(async () => {
      try {
        await groupUnsubscribeOnce();
      } catch (err) {
        this.logger?.warn('Failed to unsubscribe proof watcher during shutdown', {
          mintUrl,
          subId,
          err,
        });
      }
    });

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

  private async handleProofStateNotification(
    mintUrl: string,
    subId: string | undefined,
    secretByYHex: Map<string, string>,
    payload: ProofStateNotification,
  ): Promise<void> {
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
  }

  private async bootstrapInflightProofs(runtime: BackgroundTaskRuntime): Promise<void> {
    if (this.runtime !== runtime) return;
    this.logger?.info('Bootstrapping inflight proof watchers');

    await this.proofs.checkInflightProofs();
    if (this.runtime !== runtime) return;

    const inflightProofs = await this.proofRepository.getInflightProofs();
    if (this.runtime !== runtime || inflightProofs.length === 0) return;

    const byMint = new Map<string, string[]>();
    for (const proof of inflightProofs) {
      if (!proof.mintUrl || !proof.secret) continue;
      const secrets = byMint.get(proof.mintUrl) ?? [];
      secrets.push(proof.secret);
      byMint.set(proof.mintUrl, secrets);
    }

    for (const [mintUrl, secrets] of byMint.entries()) {
      if (this.runtime !== runtime) return;
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
