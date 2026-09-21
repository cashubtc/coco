import {
  getTokenMetadata,
  verifyProofsForReceive,
  normalizeProofAmounts,
  sumProofs,
  type Proof,
  type ProofState,
  type Token,
} from '@cashu/cashu-ts';
import type { EventBus } from '@core/events/EventBus.ts';
import type { CoreEvents } from '@core/events/types.ts';
import type { P2pkSigner } from '@core/keypairs/P2pkSigner.ts';
import type { Logger } from '@core/logging/Logger.ts';
import {
  MintOperationError,
  ProofValidationError,
  ReceiveOperationConflictError,
  TokenValidationError,
  UnknownMintError,
} from '@core/models/Error.ts';
import { createKeyChain } from '@core/proofs/KeysetSelection.ts';
import { prepareProofsForReceiving } from '@core/proofs/ProofPreparation.ts';
import type { MintService } from '@core/services/MintService.ts';
import { decodeTokenWithKeysets } from '@core/tokens/TokenDecoding.ts';
import type { ReceiveTransactions } from '@core/transactions/receive/ReceiveTransactions.ts';
import type { AppliedReceiveResult } from '@core/transactions/receive/types.ts';
import {
  computeYHexForSecrets,
  generateSubId,
  mapProofToCoreProof,
  normalizeMintUrl,
} from '@core/utils.ts';
import { MintScopedLock } from '../MintScopedLock.ts';
import { OperationIdLock } from '../OperationIdLock.ts';
import {
  createReceiveOperation,
  type ReceiveOperation,
  type ReceiveOperationSource,
  type InitReceiveOperation,
  type PreparedReceiveOperation,
  type ExecutingReceiveOperation,
  type FinalizedReceiveOperation,
  type RolledBackReceiveOperation,
} from './ReceiveOperation.ts';
import type { ReceiveOperationQueries } from './ReceiveOperationQueries.ts';
import type { ReceiveRemote, ReceiveRemoteSession } from './ReceiveRemote.ts';

// Request-validation failures prove non-effect only on the first submission, before any recovery
// claimant can replay it. Pending, already-spent, already-signed, and unknown errors do not.
const INITIAL_REJECTION_CODES = new Set([
  10001, 11005, 11007, 11008, 11009, 11010, 11014, 11015, 12001, 12002, 12003,
]);
type Publications = Array<() => Promise<void>>;

export interface ReceiveOperationServiceDependencies {
  operations: ReceiveOperationQueries;
  transactions: ReceiveTransactions;
  mintQueries: { isTrustedMint(mintUrl: string): Promise<boolean> };
  mintMetadataRefresh: Pick<MintService, 'refreshAndCommitIfStale'>;
  signer: P2pkSigner;
  loadSeed: () => Promise<Uint8Array>;
  remote: ReceiveRemote;
  eventBus: Pick<EventBus<CoreEvents>, 'emit'>;
  logger?: Logger;
  /** Shared with counter-consuming legacy workflows until their transaction migration. */
  mintScopedLock?: MintScopedLock;
}

/** Coordinates preflight, committed transitions, remote effects, and best-effort live events. */
export class ReceiveOperationService {
  private readonly operationLocks = new OperationIdLock();
  private readonly mintLock: MintScopedLock;
  private recovering = false;

  constructor(private readonly deps: ReceiveOperationServiceDependencies) {
    this.mintLock = deps.mintScopedLock ?? new MintScopedLock();
  }

  /** Decode and sign an in-memory draft. Preparation is the first durable Receive state. */
  async init(
    token: Token | string,
    source?: ReceiveOperationSource,
  ): Promise<InitReceiveOperation> {
    let mintUrl: string;
    try {
      mintUrl = normalizeMintUrl(
        typeof token === 'string' ? getTokenMetadata(token).mint : token.mint,
      );
    } catch {
      throw new ProofValidationError('Invalid token');
    }
    if (!(await this.deps.mintQueries.isTrustedMint(mintUrl)))
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    const metadata = await this.deps.mintMetadataRefresh
      .refreshAndCommitIfStale(mintUrl)
      .catch((error: unknown) => {
        throw new TokenValidationError(
          error instanceof Error ? error.message : 'Unable to retrieve mint keysets',
        );
      });
    let decoded: Token;
    try {
      decoded = decodeTokenWithKeysets(token, metadata.keysets);
      const keyChain = createKeyChain(mintUrl, decoded.unit!, metadata.keysets);
      verifyProofsForReceive(decoded.proofs, (id) => {
        const keys = keyChain.getKeyset(id).toMintKeys();
        if (!keys) throw new ProofValidationError('Receive input keyset has no keys');
        return keys;
      });
    } catch (error) {
      throw new ProofValidationError(error instanceof Error ? error.message : 'Invalid token');
    }
    const signed = await prepareProofsForReceiving(
      normalizeProofAmounts(decoded.proofs),
      this.deps.signer,
    );
    // DLEQ blinding data and local proof metadata must not be sent back to the mint.
    const proofs = signed.map(({ id, amount, secret, C, witness }) => ({
      id,
      amount,
      secret,
      C,
      witness,
    }));
    if (!proofs.length || sumProofs(proofs).isZero())
      throw new ProofValidationError('Token contains no value');
    return createReceiveOperation(
      generateSubId(),
      mintUrl,
      { amount: sumProofs(proofs), unit: decoded.unit! },
      proofs,
      source,
    );
  }

  async prepare(draft: InitReceiveOperation): Promise<PreparedReceiveOperation> {
    return this.locked(draft.id, async (publications) => {
      const stored = await this.deps.operations.getById(draft.id);
      if (stored && stored.state !== 'init') throw new ReceiveOperationConflictError(draft.id);
      const operation = stored ?? draft;
      const metadata = await this.deps.mintMetadataRefresh.refreshAndCommitIfStale(
        operation.mintUrl,
      );
      const activeKeys = createKeyChain(operation.mintUrl, operation.unit, metadata.keysets)
        .getCheapestKeyset()
        .toMintKeys();
      if (!activeKeys) throw new ProofValidationError('Active keyset is missing mint keys');
      const seed = await this.deps.loadSeed();
      const updatedAt = Date.now();
      const releaseMint = await this.mintLock.acquire(operation.mintUrl);
      let prepared;
      try {
        prepared = await this.deps.transactions.prepare({ operation, activeKeys, seed, updatedAt });
      } finally {
        releaseMint();
      }
      publications.push(() => this.emit('counter:updated', prepared.counter));
      publications.push(() =>
        this.emit('receive-op:prepared', {
          mintUrl: prepared.operation.mintUrl,
          operationId: prepared.operation.id,
          operation: prepared.operation,
        }),
      );
      return prepared.operation;
    });
  }

  async receive(token: Token | string): Promise<void> {
    await this.execute(await this.prepare(await this.init(token)));
  }

  async execute(operationOrId: ReceiveOperation | string): Promise<FinalizedReceiveOperation> {
    const id = typeof operationOrId === 'string' ? operationOrId : operationOrId.id;
    return this.locked(id, async (publications) => {
      const current = await this.require(id);
      if (current.state === 'finalized') return current;
      if (current.state !== 'prepared')
        throw new ReceiveOperationConflictError(
          id,
          `Cannot execute operation in state '${current.state}'. Expected 'prepared'.`,
        );
      // Metadata loading can fail without turning a never-submitted operation into executing.
      const remote = await this.openRemote(current);
      const executing = await this.deps.transactions.beginExecution({
        operationId: id,
        updatedAt: Date.now(),
      });
      let received: Proof[];
      try {
        received = await remote.receive(executing);
      } catch (error) {
        if (error instanceof MintOperationError && INITIAL_REJECTION_CODES.has(error.code)) {
          try {
            const failed = await this.deps.transactions.failExecution({
              operationId: id,
              expectedRevision: executing.revision ?? 0,
              updatedAt: Date.now(),
              error: error.message,
            });
            this.publishRolledBack(publications, failed);
            throw error;
          } catch (failure) {
            if (!(failure instanceof ReceiveOperationConflictError)) throw failure;
          }
        }
        // A competing recovery or a lost response may already have committed this exact request.
        await this.tryRecover(id, publications);
        const recovered = await this.require(id);
        if (recovered.state === 'finalized') return recovered;
        throw error;
      }
      return this.apply(executing, received, publications);
    });
  }

  /** Finalize only from outputs already persisted by this operation (legacy crash compatibility). */
  async finalize(operationId: string): Promise<void> {
    await this.locked(operationId, async (publications) => {
      const operation = await this.require(operationId);
      if (operation.state === 'finalized' || operation.state === 'rolled_back') return;
      if (operation.state !== 'executing')
        throw new ReceiveOperationConflictError(
          operationId,
          `Cannot finalize operation in state ${operation.state}`,
        );
      const result = await this.deps.transactions.applyResult({
        operationId,
        proofs: [],
        updatedAt: Date.now(),
      });
      if (!result)
        throw new ProofValidationError('Cannot finalize receive operation: outputs not persisted');
      this.publishApplied(publications, result);
    });
  }

  async recoverExecutingOperation(operation: ExecutingReceiveOperation): Promise<void> {
    await this.locked(operation.id, (publications) => this.tryRecover(operation.id, publications));
  }

  private async tryRecover(operationId: string, publications: Publications): Promise<void> {
    try {
      const operation = await this.require(operationId);
      if (operation.state !== 'executing') return;
      const local = await this.deps.transactions.applyResult({
        operationId,
        proofs: [],
        updatedAt: Date.now(),
      });
      if (local) {
        this.publishApplied(publications, local);
        return;
      }
      const remote = await this.openRemote(operation);
      // This fences a late rejection from the initial executor before any recovery submission.
      const claimed = await this.deps.transactions.claimRecovery({
        operationId,
        expectedRevision: operation.revision ?? 0,
        updatedAt: Date.now(),
      });
      let states = await this.observeStates(remote, claimed.inputProofs);
      if (states.every((state) => state.state === 'UNSPENT')) {
        try {
          const received = await remote.receive(claimed);
          await this.apply(claimed, received, publications);
          return;
        } catch (error) {
          // Replay failure cannot establish non-effect. Reobserve before deciding from Restore.
          if (!(error instanceof MintOperationError)) throw error;
          states = await this.observeStates(remote, claimed.inputProofs);
        }
      }
      if (!states.every((state) => state.state === 'SPENT')) return;
      const restored = await remote.restoreOutputs(claimed.outputData);
      const restoredStates = await this.observeStates(remote, restored);
      if (restoredStates.some((state) => state.state === 'PENDING')) return;
      const proofs = restored.flatMap((proof, index) =>
        mapProofToCoreProof(
          claimed.mintUrl,
          restoredStates[index]!.state === 'SPENT' ? 'spent' : 'ready',
          [proof],
          { unit: claimed.unit, createdByOperationId: claimed.id },
        ),
      );
      const result = await this.deps.transactions.applyResult({
        operationId,
        proofs,
        updatedAt: Date.now(),
      });
      if (result) {
        this.publishApplied(publications, result);
      } else if (restored.length === 0) {
        // Complete input SPENT evidence plus a well-formed empty Restore proves this allocation
        // was not issued. Any local output or a newer claimant blocks the terminal transition.
        const failed = await this.deps.transactions.failExecution({
          operationId,
          expectedRevision: claimed.revision ?? 0,
          updatedAt: Date.now(),
          error: 'Recovered: input proofs spent without recoverable outputs',
        });
        this.publishRolledBack(publications, failed);
      }
    } catch (error) {
      this.deps.logger?.warn('Receive recovery deferred; preserving the persisted request', {
        operationId,
        error,
      });
    }
  }

  private async observeStates(
    remote: ReceiveRemoteSession,
    proofs: readonly Proof[],
  ): Promise<ProofState[]> {
    if (!proofs.length) return [];
    const states = await remote.checkProofStates(proofs);
    const ys = computeYHexForSecrets(proofs.map((proof) => proof.secret));
    if (
      states.length !== proofs.length ||
      states.some(
        (state, i) => state.Y !== ys[i] || !['UNSPENT', 'PENDING', 'SPENT'].includes(state.state),
      )
    ) {
      throw new ProofValidationError('Invalid Receive proof-state evidence');
    }
    return states;
  }

  private async apply(
    operation: ExecutingReceiveOperation,
    proofs: Proof[],
    publications: Publications,
  ) {
    const result = await this.deps.transactions.applyResult({
      operationId: operation.id,
      updatedAt: Date.now(),
      proofs: mapProofToCoreProof(operation.mintUrl, 'ready', proofs, {
        unit: operation.unit,
        createdByOperationId: operation.id,
      }),
    });
    if (!result) throw new ProofValidationError('Receive result is incomplete');
    this.publishApplied(publications, result);
    return result.operation;
  }

  private async openRemote(operation: ReceiveOperation) {
    const metadata = await this.deps.mintMetadataRefresh.refreshAndCommitIfStale(operation.mintUrl);
    return this.deps.remote.open(metadata, operation.unit);
  }

  async recoverPendingOperations(): Promise<void> {
    if (this.recovering) throw new Error('Recovery is already in progress');
    this.recovering = true;
    try {
      for (const operation of await this.deps.operations.getByState('init')) {
        try {
          await this.locked(operation.id, () =>
            this.deps.transactions.cleanupLegacyInit(operation.id),
          );
        } catch (error) {
          this.deps.logger?.warn('Receive init cleanup deferred', {
            operationId: operation.id,
            error,
          });
        }
      }
      for (const operation of await this.deps.operations.getPending()) {
        if (operation.state !== 'executing') continue;
        try {
          await this.recoverExecutingOperation(operation);
        } catch (error) {
          this.deps.logger?.warn('Receive recovery skipped', { operationId: operation.id, error });
        }
      }
    } finally {
      this.recovering = false;
    }
  }

  async rollback(operationId: string, reason = 'User cancelled receive operation'): Promise<void> {
    await this.locked(operationId, async (publications) => {
      const result = await this.deps.transactions.cancel({
        operationId,
        updatedAt: Date.now(),
        reason,
      });
      if (result) this.publishRolledBack(publications, result);
    });
  }

  getOperation(operationId: string) {
    return this.deps.operations.getById(operationId);
  }
  getPendingOperations() {
    return this.deps.operations.getPending();
  }
  async getPreparedOperations(): Promise<PreparedReceiveOperation[]> {
    return (await this.deps.operations.getByState('prepared')).filter(
      (operation): operation is PreparedReceiveOperation => operation.state === 'prepared',
    );
  }
  isOperationLocked(operationId: string) {
    return this.operationLocks.isLocked(operationId);
  }
  isRecoveryInProgress() {
    return this.recovering;
  }

  private async require(id: string) {
    const operation = await this.deps.operations.getById(id);
    if (!operation) throw new ReceiveOperationConflictError(id, `Operation ${id} not found`);
    return operation;
  }

  private async locked<T>(
    id: string,
    work: (publications: Publications) => Promise<T>,
  ): Promise<T> {
    const release = await this.operationLocks.acquire(id);
    const publications: Publications = [];
    try {
      return await work(publications);
    } finally {
      release();
      for (const publish of publications) await publish();
    }
  }

  private publishApplied(publications: Publications, result: AppliedReceiveResult) {
    if (!result.committed) return;
    const byKeyset = new Map<string, typeof result.savedProofs>();
    for (const proof of result.savedProofs) {
      const group = byKeyset.get(proof.id) ?? [];
      group.push(proof);
      byKeyset.set(proof.id, group);
    }
    for (const [keysetId, proofs] of byKeyset)
      publications.push(() =>
        this.emit('proofs:saved', { mintUrl: result.operation.mintUrl, keysetId, proofs }),
      );
    if (result.spentSecrets.length)
      publications.push(() =>
        this.emit('proofs:state-changed', {
          mintUrl: result.operation.mintUrl,
          secrets: result.spentSecrets,
          state: 'spent',
        }),
      );
    publications.push(() =>
      this.emit('receive-op:finalized', {
        mintUrl: result.operation.mintUrl,
        operationId: result.operation.id,
        operation: result.operation,
      }),
    );
  }

  private publishRolledBack(publications: Publications, operation: RolledBackReceiveOperation) {
    publications.push(() =>
      this.emit('receive-op:rolled-back', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      }),
    );
  }

  private async emit<K extends keyof CoreEvents>(event: K, payload: CoreEvents[K]): Promise<void> {
    try {
      await this.deps.eventBus.emit(event, payload, { throwOnError: true });
    } catch (error) {
      this.deps.logger?.warn('Receive event listener failed after commit', { event, error });
    }
  }
}
