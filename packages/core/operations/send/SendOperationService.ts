import {
  OutputData,
  type OutputDataCreator,
  type Proof,
  type Token,
  type ProofState as CashuProofState,
} from '@cashu/cashu-ts';
import type { MintService } from '@core/services/MintService.ts';
import type { ProofQueries } from '@core/proofs/ProofQueries.ts';
import { createKeyChain } from '@core/proofs/KeysetSelection.ts';
import { feeCoveredSendAmount } from '@core/proofs/ProofSelection.ts';
import type { MintMetadata } from '@core/mints/MintMetadata.ts';
import {
  applySendResult,
  beginSendExecution,
  cancelPreparedSend,
  executeExactSend,
  failSendExecution,
  claimSendRecovery,
  cleanupLegacySendInit,
  cleanupOrphanedSendReservations,
  recoverLegacyExactSend,
  abandonSendReclaim,
  beginSendReclaim,
  completePendingSend,
  completeSendReclaim,
  prepareSend,
} from './SendTransitions.ts';

import type {
  ApplySendResult,
  BeginSendReclaimResult,
  CancelPreparedSendResult,
  ExecuteExactSendResult,
  CompletePendingSendInput,
  CompletePendingSendResult,
  CompleteSendReclaimResult,
  FailSendExecutionResult,
  PrepareSendResult,
  SwapTransportRequest,
} from './SendTransitionTypes.ts';

import type { CoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import {
  createSendOperation,
  isLegacyTokenlessP2pkSend,
  getSendProofSecrets,
  type SendOperation,
  type InitSendOperation,
  type PreparedSendOperation,
  type ExecutingSendOperation,
  type PendingSendOperation,
  type RollingBackSendOperation,
  type CreateSendOperationOptions,
} from './SendOperation';
import type { SendMethod, SendMethodData } from './SendMethodHandler';
import { SendHandlerProvider } from '../../infra/handlers/send/SendHandlerProvider';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import {
  generateSubId,
  getProofStateInputsFromSerializedOutputs,
  getSecretsFromSerializedOutputData,
  mapProofToCoreProof,
  normalizeMintUrl,
} from '../../utils';
import {
  MintOperationError,
  UnknownMintError,
  ProofValidationError,
  OperationInProgressError,
  SendOperationConflictError,
  OperationNotFoundError,
  OperationStateError,
} from '../../models/Error';
import { MintScopedLock } from '../MintScopedLock';
import { OperationIdLock } from '../OperationIdLock';
import { normalizeUnitAmount, type UnitAmount } from '../../amounts.ts';
import type { SendOperationQueries } from './SendOperationQueries.ts';
import type { SendRemote, SendRemoteSession } from './SendRemote.ts';
import { canCompleteWithInput } from './SendValidation.ts';

/** Informational observation target; applying evidence always rechecks the persisted Send. */
export interface SendProofObservationTarget {
  operationId: string;
  mintUrl: string;
  unit: string;
  id: string;
  secret: string;
  state: 'inflight' | 'spent';
}

/** Why an interrupted reclaim was left as it is. */
type UnresolvedReclaimReason =
  | 'token_proofs_missing'
  | 'no_stored_request'
  | 'method_without_reclaim'
  | 'proof_states_incomplete'
  | 'token_proofs_unsettled'
  | 'request_not_replayed'
  | 'outputs_partly_restored';

const UNRESOLVED_RECLAIM_DETAIL: Record<UnresolvedReclaimReason, string> = {
  token_proofs_missing: 'token proof metadata is missing',
  no_stored_request: 'no stored reclaim request and the token proofs are not all unspent',
  method_without_reclaim: 'the send method has no reclaim',
  proof_states_incomplete: 'proof-state response was incomplete',
  token_proofs_unsettled: 'token proofs are pending or only partly spent',
  request_not_replayed: 'token proofs are unspent and the rejected request was not sent again',
  outputs_partly_restored: 'reclaim outputs were only partly restored',
};

type SendReclaimOutcome =
  | { status: 'rolled_back'; result: CompleteSendReclaimResult }
  | { status: 'claimed'; result: CompletePendingSendResult }
  | { status: 'unresolved'; reason: UnresolvedReclaimReason };

// Explicit request-validation rejections from NUT error_codes.md. Unknown errors
// do not establish non-effect and must retain the request for recovery.
const DEFINITIVE_SWAP_MINT_ERROR_CODES = new Set([
  10001, 11005, 11007, 11008, 11009, 11010, 11014, 11015, 12001, 12002, 12003,
]);

type SwapExecutionOutcome =
  | { status: 'PENDING'; result: ApplySendResult }
  | { status: 'FAILED'; result: FailSendExecutionResult; error: MintOperationError };

export interface SendOperationServiceDependencies {
  operationQueries: SendOperationQueries;
  proofQueries: ProofQueries;
  transactionRunner: CoreTransactionRunner;
  mintQueries: { isTrustedMint(mintUrl: string): Promise<boolean> };
  mintMetadataRefresh: Pick<MintService, 'refreshAndCommitIfStale'>;
  remote: SendRemote;
  loadSeed: () => Promise<Uint8Array>;
  eventBus: Pick<EventBus<CoreEvents>, 'emit'>;
  handlerProvider: SendHandlerProvider;
  outputDataCreator?: OutputDataCreator;
  logger?: Logger;
  mintScopedLock?: MintScopedLock;
}

/** Options applied before a Send's amount and proof plan are committed. */
export interface PrepareSendOptions {
  /**
   * Treat the requested amount as the receiver's net target after redemption input fees.
   * Defaults to false (face value). The prepared amount is gross outgoing value; its fee
   * remains the separate payer-side preparation cost. Applies to unlocked and P2PK sends.
   */
  coverReceiverFees?: boolean;
}

/**
 * Options applied when a prepared send operation is executed.
 */
export interface ExecuteSendOptions {
  /** Optional memo to persist on the shareable token. Whitespace-only memos are ignored. */
  memo?: string;
}

/**
 * Service that manages send operations as sagas.
 *
 * This service provides crash recovery and rollback capabilities for send operations
 * by breaking them into discrete steps: init → prepare → execute → finalize/rollback.
 */
export class SendOperationService {
  private readonly operationQueries: SendOperationQueries;
  private readonly proofQueries: ProofQueries;
  private readonly transactionRunner: CoreTransactionRunner;
  private readonly mintQueries: SendOperationServiceDependencies['mintQueries'];
  private readonly mintMetadataRefresh: Pick<MintService, 'refreshAndCommitIfStale'>;
  private readonly remote: SendRemote;
  private readonly loadSeed: () => Promise<Uint8Array>;
  private readonly eventBus: Pick<EventBus<CoreEvents>, 'emit'>;
  private readonly handlerProvider: SendHandlerProvider;
  private readonly logger?: Logger;
  private readonly outputDataCreator: OutputDataCreator;

  /** In-memory lock to prevent concurrent operations on the same operation ID */
  private readonly operationIdLock = new OperationIdLock();
  /** Lock for the global recovery process */
  private recoveryLock: Promise<void> | null = null;
  /** In-memory lock to serialize proof selection/reservation per mint */
  private readonly mintScopedLock: MintScopedLock;

  constructor(dependencies: SendOperationServiceDependencies) {
    this.operationQueries = dependencies.operationQueries;
    this.proofQueries = dependencies.proofQueries;
    this.transactionRunner = dependencies.transactionRunner;
    this.mintQueries = dependencies.mintQueries;
    this.mintMetadataRefresh = dependencies.mintMetadataRefresh;
    this.remote = dependencies.remote;
    this.loadSeed = dependencies.loadSeed;
    this.eventBus = dependencies.eventBus;
    this.handlerProvider = dependencies.handlerProvider;
    this.logger = dependencies.logger;
    this.outputDataCreator = dependencies.outputDataCreator ?? OutputData;
    this.mintScopedLock = dependencies.mintScopedLock ?? new MintScopedLock();
  }

  /**
   * Acquire a lock for an operation.
   * Returns a release function that must be called when the operation completes.
   * Throws if the operation is already locked.
   */
  private async acquireOperationLock(operationId: string): Promise<() => void> {
    return this.operationIdLock.acquire(operationId);
  }

  /**
   * Check if an operation is currently locked.
   */
  isOperationLocked(operationId: string): boolean {
    return this.operationIdLock.isLocked(operationId);
  }

  /**
   * Check if recovery is currently in progress.
   */
  isRecoveryInProgress(): boolean {
    return this.recoveryLock !== null;
  }

  /**
   * Create a new send operation.
   * This is the entry point for the saga.
   */
  async init<M extends SendMethod = 'default'>(
    mintUrl: string,
    amount: UnitAmount,
    options: CreateSendOperationOptions<M> = {
      method: 'default' as M,
      methodData: {} as SendMethodData<M>,
    },
  ): Promise<InitSendOperation> {
    mintUrl = normalizeMintUrl(mintUrl);
    const parsed = normalizeUnitAmount(amount);
    const trusted = await this.mintQueries.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    if (parsed.amount.isZero()) {
      throw new ProofValidationError('Amount must be a positive number');
    }

    const id = generateSubId();
    const operation = createSendOperation(id, mintUrl, parsed, options);

    this.logger?.debug('Send operation initialized in memory', {
      operationId: id,
      mintUrl,
      amount: parsed.amount,
      unit: parsed.unit,
      method: options.method,
    });

    return operation;
  }

  /**
   * Prepare the operation by reserving proofs and creating outputs.
   * After this step, the operation can be executed or rolled back.
   *
   * Throws if the operation is already in progress.
   */
  async prepare(
    operation: InitSendOperation,
    options: PrepareSendOptions = {},
  ): Promise<PreparedSendOperation> {
    const releaseLock = await this.acquireOperationLock(operation.id);
    let result: PrepareSendResult;
    try {
      const releaseMintLock = await this.mintScopedLock.acquire(operation.mintUrl);
      try {
        const handler = this.handlerProvider.get(operation.method);
        if (!(await this.mintQueries.isTrustedMint(operation.mintUrl))) {
          throw new UnknownMintError(`Mint ${operation.mintUrl} is not trusted`);
        }
        const metadata = await this.mintMetadataRefresh.refreshAndCommitIfStale(operation.mintUrl);
        const keys = this.activeKeys(metadata, operation.unit);
        const seed = await this.loadSeed();
        const receiverAmount = options.coverReceiverFees ? operation.amount : undefined;
        // P2PK outputs are randomized in preflight. Unlocked Sends defer fee planning until
        // authoritative selection determines that existing proofs cannot be sent directly.
        const plannedOperation =
          receiverAmount && operation.method === 'p2pk'
            ? {
                ...operation,
                amount: feeCoveredSendAmount(
                  receiverAmount,
                  keys,
                  createKeyChain(operation.mintUrl, operation.unit, metadata.keysets),
                ),
              }
            : operation;
        const plan = handler.prepare({
          operation: plannedOperation,
          activeKeys: keys,
          mintInfo: metadata.mint.mintInfo,
          outputDataCreator: this.outputDataCreator,
        });
        const updatedAt = Date.now();
        result = await this.transactionRunner.run((tx) =>
          tx.perform(prepareSend, {
            operation: { ...plannedOperation, updatedAt },
            activeKeys: keys,
            seed,
            ...plan,
            receiverAmount,
          }),
        );
      } finally {
        releaseMintLock();
      }
    } finally {
      releaseLock();
    }
    await this.publishPrepared(result);
    return result.operation;
  }

  /**
   * Execute the prepared operation.
   * Performs the swap (if needed) and creates the token.
   * If a memo is provided, trims it and persists it on the token before saving the
   * pending operation. Whitespace-only memos are omitted.
   *
   * Swap execution commits the exact request before contacting the mint and applies a successful
   * response in a second atomic transition. Ambiguous outcomes remain executing for recovery.
   * Throws if the operation is already in progress.
   */
  async execute(
    operation: PreparedSendOperation,
    options?: ExecuteSendOptions,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    const current = await this.operationQueries.getById(operation.id);
    if (!current) {
      throw new SendOperationConflictError(
        operation.id,
        `Send operation ${operation.id} not found`,
      );
    }
    if (current.state !== 'prepared' && !(current.state === 'pending' && !current.needsSwap)) {
      throw new SendOperationConflictError(
        operation.id,
        `Cannot execute Send operation in state ${current.state}`,
      );
    }
    return current.needsSwap
      ? this.executePreparedSwap(current.id, options)
      : this.executeExactMatch(current.id, options?.memo);
  }

  private async executePreparedSwap(
    operationId: string,
    options?: ExecuteSendOptions,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    const releaseLock = await this.acquireOperationLock(operationId);
    let outcome: SwapExecutionOutcome | undefined;
    try {
      const current = await this.operationQueries.getById(operationId);
      if (!current) {
        throw new OperationNotFoundError('send', operationId);
      }
      if (current.state !== 'prepared') {
        throw new SendOperationConflictError(
          operationId,
          `Cannot execute Send operation in state ${current.state}`,
        );
      }

      outcome = await this.executeSwap(current, options);
    } finally {
      releaseLock();
    }

    if (!outcome) {
      throw new Error(`Send operation ${operationId} did not produce a pending result`);
    }
    if (outcome.status === 'FAILED') {
      await this.publishFailedSwap(outcome.result);
      throw outcome.error;
    }
    await this.publishAppliedSwap(outcome.result);
    return { operation: outcome.result.operation, token: outcome.result.operation.token! };
  }

  private async executeSwap(
    operation: PreparedSendOperation,
    options?: ExecuteSendOptions,
  ): Promise<SwapExecutionOutcome> {
    if (!operation.outputData) {
      throw new Error('Missing output data for swap operation');
    }
    const remote = this.remote.open(
      await this.mintMetadataRefresh.refreshAndCommitIfStale(operation.mintUrl),
      operation.unit,
    );
    const updatedAt = Date.now();
    const memo = options?.memo ? this.normalizeMemo(options.memo) : undefined;
    const begun = await this.transactionRunner.run((tx) =>
      tx.perform(beginSendExecution, {
        operationId: operation.id,
        updatedAt,
        memo,
      }),
    );
    return this.submitPersistedSwap(begun.operation, begun.request, remote, 'initial');
  }

  private async submitPersistedSwap(
    operation: ExecutingSendOperation,
    request: SwapTransportRequest,
    remote: SendRemoteSession,
    submission: 'initial' | 'replay',
  ): Promise<SwapExecutionOutcome> {
    let result: Awaited<ReturnType<SendRemoteSession['swap']>>;
    try {
      result = await remote.swap(request);
    } catch (error) {
      // A rejected replay cannot rule out an earlier submission still completing.
      if (submission === 'replay' || !this.isDefinitiveSwapFailure(error)) {
        throw error;
      }
      const updatedAt = Date.now();
      const failed = await this.transactionRunner.run((tx) =>
        tx.perform(failSendExecution, {
          operationId: operation.id,
          expectedRevision: operation.revision ?? 0,
          updatedAt,
          error: error.message,
        }),
      );
      return { status: 'FAILED', result: failed, error };
    }
    const keepProofs = mapProofToCoreProof(request.mintUrl, 'ready', result.keep, {
      unit: request.unit,
      createdByOperationId: operation.id,
    });
    const sendProofs = mapProofToCoreProof(request.mintUrl, 'inflight', result.send, {
      unit: request.unit,
      createdByOperationId: operation.id,
    });
    const token: Token = {
      mint: request.mintUrl,
      proofs: result.send,
      unit: request.unit,
      ...(operation.executionMemo ? { memo: operation.executionMemo } : {}),
    };

    const appliedAt = Date.now();
    const applied = await this.transactionRunner.run((tx) =>
      tx.perform(applySendResult, {
        operationId: operation.id,
        updatedAt: appliedAt,
        keepProofs,
        sendProofs,
        token,
      }),
    );
    return { status: 'PENDING', result: applied };
  }

  private async executeExactMatch(
    operationId: string,
    memo?: string,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    const releaseLock = await this.acquireOperationLock(operationId);
    let result: ExecuteExactSendResult;
    try {
      const updatedAt = Date.now();
      result = await this.transactionRunner.run((tx) =>
        tx.perform(executeExactSend, {
          operationId,
          updatedAt,
          memo,
        }),
      );
    } finally {
      releaseLock();
    }

    if (result.changed) {
      // Publish pending before proof events can trigger watcher finalization.
      await this.publishCommittedEvent('send:pending', {
        mintUrl: result.operation.mintUrl,
        operationId: result.operation.id,
        operation: result.operation,
        token: result.token,
      });
      await this.publishCommittedEvent('proofs:state-changed', {
        mintUrl: result.operation.mintUrl,
        secrets: result.operation.inputProofSecrets,
        state: 'inflight',
      });
    }

    this.logger?.info('Exact-match Send operation executed', {
      operationId,
      proofCount: result.token.proofs.length,
      changed: result.changed,
    });
    return result;
  }

  /**
   * High-level send method that orchestrates init → prepare → execute.
   * This is the main entry point for consumers.
   */
  async send(mintUrl: string, amount: UnitAmount): Promise<Token> {
    const initOp = await this.init(mintUrl, amount);
    const preparedOp = await this.prepare(initOp);
    const { token } = await this.execute(preparedOp);
    return token;
  }

  /**
   * Finalize a pending operation after its proofs have been spent.
   * This method is idempotent - calling it on an already finalized operation is a no-op.
   * If the operation was rolled back, finalization is skipped (rollback takes precedence).
   * Throws if the operation is already in progress.
   */
  async finalize(operationId: string): Promise<void> {
    const operation = await this.operationQueries.getById(operationId);
    if (!operation) throw new OperationNotFoundError('send', operationId);
    return this.completePersistedSend(operationId);
  }

  private async completePersistedSend(operationId: string): Promise<void> {
    let releaseLock: (() => void) | undefined;
    let result: CompletePendingSendResult | undefined;
    try {
      try {
        releaseLock = await this.acquireOperationLock(operationId);
      } catch (error) {
        if (!(error instanceof OperationInProgressError)) {
          throw error;
        }

        await this.operationIdLock.waitForUnlock(operationId);

        const latest = await this.operationQueries.getById(operationId);
        if (!latest) {
          throw new OperationNotFoundError('send', operationId);
        }

        if (latest.state === 'finalized') {
          this.logger?.debug('Operation finalized while waiting for lock', { operationId });
          return;
        }

        if (latest.state === 'rolled_back' || latest.state === 'rolling_back') {
          this.logger?.debug('Operation rolled back while waiting for lock', {
            operationId,
            state: latest.state,
          });
          return;
        }

        releaseLock = await this.acquireOperationLock(operationId);
      }

      const operation = await this.operationQueries.getById(operationId);
      if (!operation) {
        throw new OperationNotFoundError('send', operationId);
      }
      if (operation.state === 'finalized') {
        this.logger?.debug('Operation already finalized', { operationId });
        return;
      }

      if (operation.state === 'rolled_back' || operation.state === 'rolling_back') {
        this.logger?.debug('Operation was rolled back or is rolling back, skipping finalization', {
          operationId,
        });
        return;
      }

      if (operation.state !== 'pending') {
        throw new OperationStateError(
          {
            operationType: 'send',
            operationId,
            state: operation.state,
            expectedStates: ['pending'],
          },
          `Cannot finalize operation in state ${operation.state}`,
        );
      }
      if (isLegacyTokenlessP2pkSend(operation)) {
        const observation = await this.observeLegacyTokenlessP2pk(operation);
        if (!observation) {
          throw new ProofValidationError(`Cannot finalize unspent Send operation ${operationId}`);
        }
        result = await this.transactionRunner.run((tx) =>
          tx.perform(completePendingSend, observation),
        );
      } else {
        const sendSecrets = getSendProofSecrets(operation);
        const localProofs = await this.proofQueries.getProofsBySecrets(
          operation.mintUrl,
          sendSecrets,
        );
        const locallySpent =
          localProofs.length === new Set(sendSecrets).size &&
          localProofs.every((proof) => proof.state === 'spent');
        let observedSpentSecrets: string[] | undefined;
        if (!locallySpent) {
          const states = await this.checkProofStatesWithMint(
            operation.mintUrl,
            sendSecrets,
            operation.unit,
          );
          if (!states.every((state) => state.state === 'SPENT')) {
            throw new ProofValidationError(`Cannot finalize unspent Send operation ${operationId}`);
          }
          observedSpentSecrets = sendSecrets;
        }
        const updatedAt = Date.now();
        result = await this.transactionRunner.run((tx) =>
          tx.perform(completePendingSend, {
            operationId,
            updatedAt,
            spentProofSecrets: observedSpentSecrets,
          }),
        );
      }
    } finally {
      releaseLock?.();
    }
    if (result) await this.publishCompletedSend(result);
  }

  /**
   * Cancel a prepared operation and release its reservations.
   * Reclaim commits its Output Allocation before mint I/O and applies the result atomically.
   * A reclaim whose mint call fails makes one attempt to settle from mint evidence before rejecting.
   * Throws if the operation is already in progress.
   */
  async rollback(operationId: string, reason = 'Rolled back by user action'): Promise<void> {
    const operation = await this.operationQueries.getById(operationId);
    if (!operation) throw new OperationNotFoundError('send', operationId);
    const handler = this.handlerProvider.get(operation.method);
    if (operation.state !== 'prepared' && !handler.canReclaim) {
      throw new OperationStateError(
        {
          operationType: 'send',
          operationId,
          state: operation.state,
          expectedStates: ['prepared'],
        },
        `P2PK Send Operation in ${operation.state} state can not be rolled back.`,
      );
    }
    return this.rollbackPersistedSend(operationId, reason);
  }

  private async rollbackPersistedSend(operationId: string, reason: string): Promise<void> {
    const releaseLock = await this.acquireOperationLock(operationId);
    let cancelled: CancelPreparedSendResult | undefined;
    let reclaimed: CompleteSendReclaimResult | undefined;
    let claimed: CompletePendingSendResult | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const operation = await this.operationQueries.getById(operationId);
      if (!operation) {
        throw new OperationNotFoundError('send', operationId);
      }
      if (operation.state === 'prepared') {
        const updatedAt = Date.now();
        cancelled = await this.transactionRunner.run((tx) =>
          tx.perform(cancelPreparedSend, {
            operationId,
            updatedAt,
            reason,
          }),
        );
      } else if (operation.state === 'pending' && operation.method === 'default') {
        const metadata = await this.mintMetadataRefresh.refreshAndCommitIfStale(operation.mintUrl);
        const remote = this.remote.open(metadata, operation.unit);
        const begun = await this.beginReclaim(operation, metadata);
        try {
          reclaimed = await this.submitSendReclaim(
            begun.operation,
            begun.inputProofs,
            remote,
            reason,
          );
        } catch (error) {
          failure = { error };
          // The request may have reached the mint. Make one attempt to settle from mint evidence.
          // A definitive rejection had no effect there, so the same request is not sent again.
          try {
            const outcome = await this.resolveInterruptedReclaim(begun.operation, reason, {
              replayStoredRequest: !this.isDefinitiveSwapFailure(error),
            });
            if (outcome.status === 'rolled_back') {
              reclaimed = outcome.result;
              failure = undefined;
            } else if (outcome.status === 'claimed') {
              claimed = outcome.result;
            }
          } catch (resolveError) {
            this.logger?.warn('Could not settle a failed Send reclaim; leaving it for recovery', {
              operationId,
              error: resolveError instanceof Error ? resolveError.message : String(resolveError),
            });
          }
        }
      } else {
        throw new OperationStateError(
          {
            operationType: 'send',
            operationId,
            state: operation.state,
            expectedStates: ['prepared', 'pending'],
          },
          `Cannot rollback operation in state ${operation.state}`,
        );
      }
    } finally {
      releaseLock();
    }
    if (cancelled) await this.publishCancelledSend(cancelled);
    if (reclaimed) await this.publishReclaimedSend(reclaimed);
    if (claimed) await this.publishCompletedSend(claimed);
    if (failure) throw failure.error;
  }

  private async publishReclaimedSend(reclaimed: CompleteSendReclaimResult): Promise<void> {
    await this.publishSavedProofs(reclaimed.operation.mintUrl, reclaimed.savedProofs);
    if (reclaimed.spentProofSecrets.length > 0)
      await this.publishCommittedEvent('proofs:state-changed', {
        mintUrl: reclaimed.operation.mintUrl,
        secrets: reclaimed.spentProofSecrets,
        state: 'spent',
      });
    if (reclaimed.releasedProofSecrets.length > 0)
      await this.publishCommittedEvent('proofs:released', {
        mintUrl: reclaimed.operation.mintUrl,
        secrets: reclaimed.releasedProofSecrets,
      });
    await this.publishCommittedEvent('send:rolled-back', {
      mintUrl: reclaimed.operation.mintUrl,
      operationId: reclaimed.operation.id,
      operation: reclaimed.operation,
    });
  }

  /**
   * Commit the reclaim request for a `pending` Send. For a `rolling_back` Send, abandon its
   * reclaim and begin a new one in the same transaction.
   */
  private async beginReclaim(
    operation: PendingSendOperation | RollingBackSendOperation,
    metadata: MintMetadata,
  ): Promise<BeginSendReclaimResult> {
    const updatedAt = Date.now();
    const activeKeys = this.activeKeys(metadata, operation.unit);
    const seed = await this.loadSeed();
    const begun = await this.transactionRunner.run(async (tx) => {
      if (operation.state === 'rolling_back') {
        await tx.perform(abandonSendReclaim, {
          operationId: operation.id,
          expectedRevision: operation.revision ?? 0,
          updatedAt,
        });
      }
      return tx.perform(beginSendReclaim, {
        operationId: operation.id,
        updatedAt,
        activeKeys,
        seed,
      });
    });
    if (begun.counter) await this.publishCommittedEvent('counter:updated', begun.counter);
    if (begun.skippedForFees) {
      this.logger?.warn('Cannot reclaim send proofs because fees consume the amount', {
        operationId: operation.id,
      });
    }
    return begun;
  }

  /** Submit the committed reclaim request, if the reclaim has one, and apply the result. */
  private async submitSendReclaim(
    operation: RollingBackSendOperation,
    inputProofs: Proof[],
    remote: SendRemoteSession,
    reason: string,
  ): Promise<CompleteSendReclaimResult> {
    const proofs = operation.reclaimData
      ? await remote.reclaim(inputProofs, operation.reclaimData.outputData)
      : [];
    return this.applySendReclaim(operation, proofs, reason);
  }

  private async applySendReclaim(
    operation: RollingBackSendOperation,
    proofs: Proof[],
    reason: string,
  ): Promise<CompleteSendReclaimResult> {
    const updatedAt = Date.now();
    const reclaimedProofs = mapProofToCoreProof(operation.mintUrl, 'ready', proofs, {
      unit: operation.unit,
    });
    return this.transactionRunner.run((tx) =>
      tx.perform(completeSendReclaim, {
        operationId: operation.id,
        updatedAt,
        reason,
        proofs: reclaimedProofs,
      }),
    );
  }

  /**
   * Settle a reclaim that stopped after `rolling_back` was committed. The caller holds the
   * operation lock. Reclaim outputs the wallet already stores settle it without the mint. Mint
   * I/O runs outside transactions; evidence that does not decide the outcome leaves the Send and
   * its reclaim request untouched.
   */
  private async resolveInterruptedReclaim(
    operation: RollingBackSendOperation,
    reason: string,
    options: { replayStoredRequest: boolean } = { replayStoredRequest: true },
  ): Promise<SendReclaimOutcome> {
    const plan = operation.reclaimData;
    const secrets = plan ? plan.inputProofSecrets : getSendProofSecrets(operation);
    const stored = await this.proofQueries.getProofsBySecrets(operation.mintUrl, secrets);
    const bySecret = new Map(stored.map((proof) => [proof.secret, proof]));
    if (secrets.length === 0 || bySecret.size !== secrets.length) {
      return { status: 'unresolved', reason: 'token_proofs_missing' };
    }
    const inputProofs = secrets.map((secret) => bySecret.get(secret)!);
    const outputSecrets = plan
      ? getSecretsFromSerializedOutputData(plan.outputData).keepSecrets
      : [];

    if (plan) {
      // The mint signs these outputs only for this request, so holding all of them, for example
      // after a Restore, shows the reclaim landed. Completion keeps the stored rows as they are.
      const held = await this.proofQueries.getProofsBySecrets(operation.mintUrl, outputSecrets);
      if (outputSecrets.length > 0 && held.length === outputSecrets.length) {
        return {
          status: 'rolled_back',
          result: await this.applySendReclaim(operation, held, reason),
        };
      }
    }

    const metadata = await this.mintMetadataRefresh.refreshAndCommitIfStale(operation.mintUrl);
    const remote = this.remote.open(metadata, operation.unit);
    const states = await remote.checkProofStates(inputProofs);
    if (states.length !== inputProofs.length) {
      return { status: 'unresolved', reason: 'proof_states_incomplete' };
    }
    const allUnspent = states.every((state) => state.state === 'UNSPENT');
    const allSpent = states.every((state) => state.state === 'SPENT');

    if (!plan) {
      // No request was stored, so spent token proofs cannot be attributed to either party.
      if (!allUnspent || inputProofs.some((proof) => proof.state !== 'inflight')) {
        return { status: 'unresolved', reason: 'no_stored_request' };
      }
      // Nothing was reclaimed or claimed. Start again with a stored request.
      const begun = await this.beginReclaim(operation, metadata);
      return {
        status: 'rolled_back',
        result: await this.submitSendReclaim(begun.operation, begun.inputProofs, remote, reason),
      };
    }

    if (allUnspent) {
      if (!options.replayStoredRequest) {
        return { status: 'unresolved', reason: 'request_not_replayed' };
      }
      return {
        status: 'rolled_back',
        result: await this.submitSendReclaim(operation, inputProofs, remote, reason),
      };
    }
    if (!allSpent) {
      return { status: 'unresolved', reason: 'token_proofs_unsettled' };
    }

    // A strict Restore returns nothing only when the mint signed none of the reclaim outputs.
    const restored = await remote.restoreOutputs(plan.outputData, { requireComplete: true });
    if (restored.length === 0) {
      // The token proofs are spent and the reclaim never landed: the recipient claimed.
      const updatedAt = Date.now();
      const result = await this.transactionRunner.run(async (tx) => {
        await tx.perform(abandonSendReclaim, {
          operationId: operation.id,
          expectedRevision: operation.revision ?? 0,
          updatedAt,
        });
        return tx.perform(completePendingSend, {
          operationId: operation.id,
          updatedAt,
          spentProofSecrets: plan.inputProofSecrets,
        });
      });
      return { status: 'claimed', result };
    }
    const restoredSecrets = new Set(restored.map((proof) => proof.secret));
    if (
      restored.length !== outputSecrets.length ||
      !outputSecrets.every((secret) => restoredSecrets.has(secret))
    ) {
      return { status: 'unresolved', reason: 'outputs_partly_restored' };
    }
    return {
      status: 'rolled_back',
      result: await this.applySendReclaim(operation, restored, reason),
    };
  }

  /** Recovery entry: take the operation lock, settle, then publish outside the lock. */
  private async recoverRollingBackOperation(op: SendOperation): Promise<void> {
    let releaseLock: () => void;
    try {
      releaseLock = await this.acquireOperationLock(op.id);
    } catch (error) {
      if (!(error instanceof OperationInProgressError)) throw error;
      this.logger?.debug('Skipping rolling_back Send recovery because it is in progress', {
        operationId: op.id,
      });
      return;
    }
    let outcome: SendReclaimOutcome;
    try {
      const latest = await this.operationQueries.getById(op.id);
      if (!latest || latest.state !== 'rolling_back') {
        this.logger?.debug('Skipping rolling_back Send recovery because state changed', {
          operationId: op.id,
          state: latest?.state,
        });
        return;
      }
      outcome =
        latest.method === 'default'
          ? await this.resolveInterruptedReclaim(latest, 'Reclaim completed during recovery')
          : { status: 'unresolved', reason: 'method_without_reclaim' };
    } finally {
      releaseLock();
    }

    if (outcome.status === 'rolled_back') {
      await this.publishReclaimedSend(outcome.result);
      this.logger?.info('Completed an interrupted Send reclaim during recovery', {
        operationId: op.id,
      });
      return;
    }
    if (outcome.status === 'claimed') {
      await this.publishCompletedSend(outcome.result);
      this.logger?.info('Interrupted Send reclaim found the token claimed', {
        operationId: op.id,
        state: outcome.result.operation.state,
      });
      return;
    }
    const detail = UNRESOLVED_RECLAIM_DETAIL[outcome.reason];
    switch (outcome.reason) {
      // The stored record cannot settle these; the value is only reachable through a Restore.
      case 'token_proofs_missing':
      case 'no_stored_request':
      case 'method_without_reclaim':
        this.logger?.warn(
          'Found operation stuck in rolling_back state. ' +
            'This indicates a crash during rollback. Manual recovery via seed restore may be needed.',
          {
            operationId: op.id,
            mintUrl: op.mintUrl,
            amount: op.amount,
            reason: outcome.reason,
            detail,
          },
        );
        return;
      default:
        this.logger?.warn('Send reclaim outcome remains ambiguous; preserving recovery material', {
          operationId: op.id,
          reason: outcome.reason,
          detail,
        });
    }
  }

  /**
   * Recover pending operations on startup.
   * This should be called during initialization.
   * Throws if recovery is already in progress.
   */
  async recoverPendingOperations(): Promise<void> {
    if (this.recoveryLock) {
      throw new Error('Recovery is already in progress');
    }

    let releaseRecoveryLock: () => void;
    this.recoveryLock = new Promise<void>((resolve) => {
      releaseRecoveryLock = resolve;
    });

    try {
      let initCount = 0;
      let executingCount = 0;
      let pendingCount = 0;
      let rollingBackCount = 0;
      let orphanCount = 0;

      // 1. Clean up failed init operations
      const initOps = await this.operationQueries.getByState('init');
      for (const op of initOps) {
        await this.recoverInitOperation(op as InitSendOperation);
        initCount++;
      }

      // 2. Log warnings for prepared operations (leave for user to decide)
      const preparedOps = await this.operationQueries.getByState('prepared');
      for (const op of preparedOps) {
        this.logger?.warn('Found stale prepared operation, user can rollback manually', {
          operationId: op.id,
        });
      }

      // 3. Recover executing operations
      const executingOps = await this.operationQueries.getByState('executing');
      for (const op of executingOps) {
        try {
          await this.recoverExecutingOperation(op as ExecutingSendOperation);
          executingCount++;
        } catch (e) {
          this.logger?.error('Error recovering executing operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // 4. Check pending operations
      const pendingOps = await this.operationQueries.getByState('pending');
      for (const op of pendingOps) {
        try {
          await this.checkPendingOperation(op as PendingSendOperation);
          pendingCount++;
        } catch (e) {
          this.logger?.error('Error checking pending operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // 5. Settle interrupted reclaims from mint evidence
      const rollingBackOps = await this.operationQueries.getByState('rolling_back');
      for (const op of rollingBackOps) {
        try {
          await this.recoverRollingBackOperation(op);
        } catch (e) {
          this.logger?.error('Error recovering rolling_back operation', {
            operationId: op.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        rollingBackCount++;
      }

      // 6. Clean up orphaned proof reservations
      orphanCount = await this.cleanupOrphanedReservations();

      this.logger?.info('Recovery completed', {
        initOperations: initCount,
        executingOperations: executingCount,
        pendingOperations: pendingCount,
        rollingBackOperations: rollingBackCount,
        orphanedReservations: orphanCount,
      });
    } finally {
      this.recoveryLock = null;
      releaseRecoveryLock!();
    }
  }

  /**
   * Clean up a failed init operation.
   * Releases any orphaned proof reservations and deletes the operation.
   */
  private async recoverInitOperation(op: InitSendOperation): Promise<void> {
    const result = await this.transactionRunner.run((tx) =>
      tx.perform(cleanupLegacySendInit, op.id),
    );
    if (result.releasedProofSecrets.length > 0) {
      await this.publishCommittedEvent('proofs:released', {
        mintUrl: result.mintUrl,
        secrets: result.releasedProofSecrets,
      });
    }
    this.logger?.info('Cleaned up failed init operation', { operationId: op.id });
  }

  /**
   * Recover an executing swap using only its persisted inputs, outputs, and memo.
   */
  private async recoverExecutingOperation(op: ExecutingSendOperation): Promise<void> {
    const latest = await this.operationQueries.getById(op.id);
    if (!latest || latest.state !== 'executing') {
      this.logger?.debug('Skipping executing Send recovery because state changed', {
        operationId: op.id,
        state: latest?.state,
      });
      return;
    }
    if (!latest.needsSwap) {
      const updatedAt = Date.now();
      const recovered = await this.transactionRunner.run((tx) =>
        tx.perform(recoverLegacyExactSend, {
          operationId: latest.id,
          updatedAt,
        }),
      );
      if (recovered.readyProofSecrets.length > 0) {
        await this.publishCommittedEvent('proofs:state-changed', {
          mintUrl: recovered.operation.mintUrl,
          secrets: recovered.readyProofSecrets,
          state: 'ready',
        });
      }
      await this.publishCancelledSend(recovered);
      return;
    }
    if (!latest.outputData) {
      this.logger?.warn('Executing Send lacks a persisted swap request; leaving it for recovery', {
        operationId: latest.id,
      });
      return;
    }

    const storedInputs = await this.proofQueries.getProofsBySecrets(
      latest.mintUrl,
      latest.inputProofSecrets,
    );
    const inputBySecret = new Map(storedInputs.map((proof) => [proof.secret, proof]));
    if (inputBySecret.size !== latest.inputProofSecrets.length) {
      throw new ProofValidationError('Cannot recover Send operation: missing input proof metadata');
    }
    const inputProofs = latest.inputProofSecrets.map(
      (secret) => inputBySecret.get(secret) as Proof,
    );
    const remote = this.remote.open(
      await this.mintMetadataRefresh.refreshAndCommitIfStale(latest.mintUrl),
      latest.unit,
    );
    const inputStates = await remote.checkProofStates(inputProofs);
    if (inputStates.length !== inputProofs.length) {
      this.logger?.warn(
        'Executing Send proof-state response was incomplete; preserving recovery material',
        { operationId: latest.id },
      );
      return;
    }
    const allUnspent = inputStates.every((state) => state.state === 'UNSPENT');
    const allSpent = inputStates.every((state) => state.state === 'SPENT');

    if (allUnspent) {
      const claimedAt = Date.now();
      const claimed = await this.transactionRunner.run((tx) =>
        tx.perform(claimSendRecovery, {
          operationId: latest.id,
          expectedRevision: latest.revision ?? 0,
          updatedAt: claimedAt,
        }),
      );
      const outcome = await this.submitPersistedSwap(
        claimed.operation,
        claimed.request,
        remote,
        'replay',
      );
      if (outcome.status === 'FAILED') {
        await this.publishFailedSwap(outcome.result);
      } else {
        await this.publishAppliedSwap(outcome.result);
      }
      this.logger?.info('Replayed executing Send from its persisted request', {
        operationId: latest.id,
        result: outcome.status,
      });
      return;
    }

    if (!allSpent) {
      this.logger?.warn('Executing Send outcome remains ambiguous; preserving recovery material', {
        operationId: latest.id,
      });
      return;
    }

    const claimedAt = Date.now();
    const claimed = await this.transactionRunner.run((tx) =>
      tx.perform(claimSendRecovery, {
        operationId: latest.id,
        expectedRevision: latest.revision ?? 0,
        updatedAt: claimedAt,
      }),
    );
    const recoveryOperation = claimed.operation;

    const outputSecrets = getSecretsFromSerializedOutputData(recoveryOperation.outputData!);
    const expectedSecrets = [...outputSecrets.keepSecrets, ...outputSecrets.sendSecrets];
    const storedOutputs = await this.proofQueries.getProofsBySecrets(
      recoveryOperation.mintUrl,
      expectedSecrets,
    );
    const recoveredBySecret = new Map<string, Proof>(
      storedOutputs
        .filter((proof) => proof.createdByOperationId === recoveryOperation.id)
        .map((proof) => [proof.secret, proof]),
    );
    if (!expectedSecrets.every((secret) => recoveredBySecret.has(secret))) {
      const recovered = await remote.restoreOutputs(recoveryOperation.outputData!);
      for (const proof of recovered) {
        if (!recoveredBySecret.has(proof.secret)) recoveredBySecret.set(proof.secret, proof);
      }
    }
    if (!expectedSecrets.every((secret) => recoveredBySecret.has(secret))) {
      this.logger?.warn(
        'Executing Send outputs could not be fully reconstructed; preserving recovery material',
        { operationId: recoveryOperation.id },
      );
      return;
    }

    const keepProofs = mapProofToCoreProof(
      recoveryOperation.mintUrl,
      'ready',
      outputSecrets.keepSecrets.map((secret) => recoveredBySecret.get(secret)!),
      { unit: recoveryOperation.unit, createdByOperationId: recoveryOperation.id },
    );
    const sendProofs = mapProofToCoreProof(
      recoveryOperation.mintUrl,
      'inflight',
      outputSecrets.sendSecrets.map((secret) => recoveredBySecret.get(secret)!),
      { unit: recoveryOperation.unit, createdByOperationId: recoveryOperation.id },
    );
    const token: Token = {
      mint: recoveryOperation.mintUrl,
      proofs: outputSecrets.sendSecrets.map((secret) => recoveredBySecret.get(secret)!),
      unit: recoveryOperation.unit,
      ...(recoveryOperation.executionMemo ? { memo: recoveryOperation.executionMemo } : {}),
    };
    const appliedAt = Date.now();
    const applied = await this.transactionRunner.run((tx) =>
      tx.perform(applySendResult, {
        operationId: recoveryOperation.id,
        updatedAt: appliedAt,
        keepProofs,
        sendProofs,
        token,
      }),
    );
    await this.publishAppliedSwap(applied);
    this.logger?.info('Restored executing Send outputs from its persisted request', {
      operationId: recoveryOperation.id,
    });
  }

  /**
   * Check a pending operation to see if it should be finalized.
   */
  async checkPendingOperation(op: PendingSendOperation): Promise<void> {
    const latest = await this.operationQueries.getById(op.id);
    if (!latest || latest.state !== 'pending') return;
    return this.checkPersistedSend(latest);
  }

  private async checkPersistedSend(op: PendingSendOperation): Promise<void> {
    const latest = await this.operationQueries.getById(op.id);
    if (!latest || latest.state !== 'pending') return;
    const sendSecrets = getSendProofSecrets(latest);
    let completion: CompletePendingSendInput | null;
    try {
      if (isLegacyTokenlessP2pkSend(latest)) {
        completion = await this.observeLegacyTokenlessP2pk(latest);
      } else {
        const states = await this.checkProofStatesWithMint(
          latest.mintUrl,
          sendSecrets,
          latest.unit,
        );
        completion = states.every((state) => state.state === 'SPENT')
          ? { operationId: latest.id, updatedAt: Date.now(), spentProofSecrets: sendSecrets }
          : null;
      }
    } catch (_e) {
      this.logger?.warn('Could not reach mint for recovery, will retry later', {
        operationId: latest.id,
        mintUrl: latest.mintUrl,
      });
      return;
    }

    if (!completion) {
      this.logger?.debug('Pending operation token not yet claimed, leaving as pending', {
        operationId: latest.id,
      });
      return;
    }

    const result = await this.transactionRunner.run((tx) =>
      tx.perform(completePendingSend, completion),
    );
    await this.publishCompletedSend(result);
    this.logger?.info('Send operation finalized during recovery', { operationId: latest.id });
  }

  /**
   * Apply SPENT evidence and any resulting Send completion in one transaction. Partial evidence
   * leaves the Send pending. Duplicate evidence is harmless; no watcher has proof write authority.
   * Legacy tokenless P2PK Sends still require verification of their complete exact output plan.
   * Callers supply trusted mint evidence. A true result means the observation was handled, not
   * necessarily that the Send finalized.
   */
  async applyProofStateObservation(
    operationId: string,
    spentSecrets: readonly string[],
  ): Promise<boolean> {
    const operation = await this.operationQueries.getById(operationId);
    if (!operation || operation.state !== 'pending') return false;
    const expected = new Set(getSendProofSecrets(operation));
    if (spentSecrets.some((secret) => !expected.has(secret))) {
      throw new ProofValidationError('Observed proof does not belong to Send operation');
    }
    if (spentSecrets.length === 0) return false;
    const completion = isLegacyTokenlessP2pkSend(operation)
      ? await this.observeLegacyTokenlessP2pk(operation)
      : { operationId, updatedAt: Date.now(), spentProofSecrets: [...new Set(spentSecrets)] };
    if (!completion) return true;
    const result = await this.transactionRunner.run((tx) =>
      tx.perform(completePendingSend, completion),
    );
    await this.publishCompletedSend(result);
    return true;
  }

  /**
   * Reassess persisted proof evidence without polling. Legacy tokenless P2PK records wait for
   * Operation Recovery or a new observation to verify their complete allocation with the mint.
   * The completion transition rechecks state, exact proofs and ownership in its transaction.
   */
  async advancePendingOperation(operationId: string): Promise<void> {
    const operation = await this.operationQueries.getById(operationId);
    if (!operation || operation.state !== 'pending') return;
    if (isLegacyTokenlessP2pkSend(operation)) return;
    const secrets = getSendProofSecrets(operation);
    const proofs = await this.proofQueries.getProofsBySecrets(operation.mintUrl, secrets);
    if (
      secrets.length === 0 ||
      proofs.length !== new Set(secrets).size ||
      proofs.some((proof) => proof.state !== 'spent')
    )
      return;
    const updatedAt = Date.now();
    const result = await this.transactionRunner.run((tx) =>
      tx.perform(completePendingSend, { operationId, updatedAt }),
    );
    await this.publishCompletedSend(result);
  }

  /**
   * Discover pending Send targets by operation or by a local proof-event hint. No writes or remote
   * effects occur here. Missing/terminal owners and proofs reserved by another operation are omitted.
   * Legacy tokenless outputs are derived from their persisted allocation, without fabricating rows.
   */
  async getProofObservationTargets(
    input: string | { mintUrl: string; secrets: string[] },
  ): Promise<SendProofObservationTarget[]> {
    const requested = typeof input === 'string' ? undefined : new Set(input.secrets);
    const mintUrl = typeof input === 'string' ? undefined : normalizeMintUrl(input.mintUrl);
    const candidates =
      typeof input === 'string'
        ? [input]
        : (await this.proofQueries.getProofsBySecrets(mintUrl!, input.secrets))
            .map((proof) => proof.usedByOperationId ?? proof.createdByOperationId)
            .filter((id): id is string => id != null);
    const targets: SendProofObservationTarget[] = [];
    for (const operationId of new Set(candidates)) {
      const operation = await this.operationQueries.getById(operationId);
      if (
        !operation ||
        operation.state !== 'pending' ||
        (mintUrl !== undefined && operation.mintUrl !== mintUrl)
      )
        continue;
      const secrets = getSendProofSecrets(operation);
      const proofs = new Map(
        (await this.proofQueries.getProofsBySecrets(operation.mintUrl, secrets)).map((proof) => [
          proof.secret,
          proof,
        ]),
      );
      const legacy = isLegacyTokenlessP2pkSend(operation)
        ? new Map(
            getProofStateInputsFromSerializedOutputs(operation.outputData.send).map((proof) => [
              proof.secret,
              proof,
            ]),
          )
        : undefined;
      for (const secret of secrets) {
        if (requested && !requested.has(secret)) continue;
        const proof = proofs.get(secret);
        if (proof && proof.state !== 'inflight' && proof.state !== 'spent') continue;
        if (proof && proof.usedByOperationId != null && proof.usedByOperationId !== operationId)
          continue;
        if (
          proof &&
          !(operation.needsSwap
            ? proof.createdByOperationId === operationId
            : canCompleteWithInput(proof, operationId))
        )
          continue;
        const id = proof?.id ?? legacy?.get(secret)?.id;
        if (!id) continue;
        targets.push({
          operationId,
          mintUrl: operation.mintUrl,
          unit: operation.unit,
          id,
          secret,
          state: proof?.state === 'spent' ? 'spent' : 'inflight',
        });
      }
    }
    return targets;
  }

  private async observeLegacyTokenlessP2pk(
    operation: PendingSendOperation & {
      outputData: NonNullable<PendingSendOperation['outputData']>;
    },
  ): Promise<CompletePendingSendInput | null> {
    const outputData = structuredClone(operation.outputData);
    const proofInputs = getProofStateInputsFromSerializedOutputs(outputData.send);
    if (
      proofInputs.some((proof) => !proof.id || !proof.secret) ||
      new Set(proofInputs.map((proof) => proof.secret)).size !== proofInputs.length
    ) {
      throw new ProofValidationError('Cannot check legacy P2PK Send: invalid output allocation');
    }
    const remote = this.remote.open(
      await this.mintMetadataRefresh.refreshAndCommitIfStale(operation.mintUrl),
      operation.unit,
    );
    const states = await remote.checkProofStates(proofInputs);
    if (states.length !== proofInputs.length) {
      throw new ProofValidationError('Cannot check legacy P2PK Send: incomplete mint response');
    }
    if (!states.every((state) => state.state === 'SPENT')) return null;
    return {
      operationId: operation.id,
      updatedAt: Date.now(),
      spentProofSecrets: proofInputs.map((proof) => proof.secret),
      legacyP2pkOutputObservation: {
        expectedRevision: operation.revision ?? 0,
        mintUrl: operation.mintUrl,
        unit: operation.unit,
        outputData,
      },
    };
  }

  /**
   * Check proof states with the mint.
   */
  private async checkProofStatesWithMint(
    mintUrl: string,
    secrets: string[],
    unit: string,
  ): Promise<CashuProofState[]> {
    const remote = this.remote.open(
      await this.mintMetadataRefresh.refreshAndCommitIfStale(mintUrl),
      unit,
    );
    const proofInputs = await this.proofQueries.getProofsBySecrets(mintUrl, secrets);
    if (proofInputs.length !== secrets.length) {
      throw new ProofValidationError('Cannot check proof states: missing proof metadata');
    }
    const states = await remote.checkProofStates(proofInputs);
    if (states.length !== proofInputs.length) {
      throw new ProofValidationError('Cannot check proof states: incomplete mint response');
    }
    return states;
  }

  /**
   * Clean up orphaned proof reservations.
   * Releases proofs reserved by known terminal Sends; unidentified owners remain reserved.
   */
  private async cleanupOrphanedReservations(): Promise<number> {
    const result = await this.transactionRunner.run((tx) =>
      tx.perform(cleanupOrphanedSendReservations),
    );
    for (const group of result.released) {
      await this.publishCommittedEvent('proofs:released', group);
    }
    if (result.count > 0) {
      this.logger?.info('Released orphaned proof reservations', { count: result.count });
    }
    return result.count;
  }

  private async publishPrepared(result: PrepareSendResult): Promise<void> {
    if (result.counter) {
      await this.publishCommittedEvent('counter:updated', result.counter);
    }
    await this.publishCommittedEvent('proofs:reserved', {
      mintUrl: result.reservation.mintUrl,
      operationId: result.reservation.operationId,
      secrets: result.reservation.secrets,
      amount: {
        amount: result.reservation.amount,
        unit: result.reservation.unit,
      },
    });
    await this.publishCommittedEvent('send:prepared', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
    });
  }

  private async publishSavedProofs(
    mintUrl: string,
    savedProofs: import('@core/types.ts').CoreProof[],
  ): Promise<void> {
    const groups = new Map<string, typeof savedProofs>();
    for (const proof of savedProofs) groups.set(proof.id, [...(groups.get(proof.id) ?? []), proof]);
    for (const [keysetId, proofs] of groups)
      await this.publishCommittedEvent('proofs:saved', { mintUrl, keysetId, proofs });
  }

  private async publishAppliedSwap(result: ApplySendResult): Promise<void> {
    if (!result.changed) return;

    // Saved inflight proofs can immediately trigger watcher finalization.
    await this.publishCommittedEvent('send:pending', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
      token: result.operation.token!,
    });
    await this.publishSavedProofs(result.operation.mintUrl, result.savedProofs);
    if (result.inflightProofSecrets.length > 0) {
      await this.publishCommittedEvent('proofs:state-changed', {
        mintUrl: result.operation.mintUrl,
        secrets: result.inflightProofSecrets,
        state: 'inflight',
      });
    }
    await this.publishCommittedEvent('proofs:state-changed', {
      mintUrl: result.operation.mintUrl,
      secrets: result.spentInputSecrets,
      state: 'spent',
    });
  }

  private async publishFailedSwap(result: FailSendExecutionResult): Promise<void> {
    if (!result.changed) return;

    await this.publishCommittedEvent('proofs:released', {
      mintUrl: result.operation.mintUrl,
      secrets: result.releasedInputSecrets,
    });
    await this.publishCommittedEvent('send:rolled-back', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
    });
  }

  private async publishCancelledSend(result: CancelPreparedSendResult): Promise<void> {
    if (!result.changed) return;
    await this.publishCommittedEvent('proofs:released', {
      mintUrl: result.operation.mintUrl,
      secrets: result.releasedInputSecrets,
    });
    await this.publishCommittedEvent('send:rolled-back', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
    });
    this.logger?.info('Prepared Send operation cancelled', { operationId: result.operation.id });
  }

  private async publishCompletedSend(result: CompletePendingSendResult): Promise<void> {
    if (!result.changed) return;
    if (result.spentProofSecrets.length > 0) {
      await this.publishCommittedEvent('proofs:state-changed', {
        mintUrl: result.operation.mintUrl,
        secrets: result.spentProofSecrets,
        state: 'spent',
      });
    }
    if (result.releasedInputSecrets.length > 0) {
      await this.publishCommittedEvent('proofs:released', {
        mintUrl: result.operation.mintUrl,
        secrets: result.releasedInputSecrets,
      });
    }
    if (result.operation.state === 'finalized') {
      await this.publishCommittedEvent('send:finalized', {
        mintUrl: result.operation.mintUrl,
        operationId: result.operation.id,
        operation: result.operation,
      });
      this.logger?.info('Send operation finalized', { operationId: result.operation.id });
    }
  }

  private activeKeys(metadata: MintMetadata, unit: string) {
    const keys = createKeyChain(metadata.mint.mintUrl, unit, metadata.keysets)
      .getCheapestKeyset()
      .toMintKeys();
    if (!keys) throw new ProofValidationError('Active keyset is missing mint keys');
    return keys;
  }

  private isDefinitiveSwapFailure(error: unknown): error is MintOperationError {
    return error instanceof MintOperationError && DEFINITIVE_SWAP_MINT_ERROR_CODES.has(error.code);
  }

  private async publishCommittedEvent<E extends keyof CoreEvents>(
    event: E,
    payload: CoreEvents[E],
  ): Promise<void> {
    try {
      await this.eventBus.emit(event, payload, { throwOnError: true });
    } catch (error) {
      this.logger?.error('Failed to publish committed Send event', { event, error });
    }
  }

  private normalizeMemo(memo: string): string | undefined {
    const trimmed = memo.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * Get an operation by ID.
   */
  async getOperation(operationId: string): Promise<SendOperation | null> {
    return this.operationQueries.getById(operationId);
  }

  /**
   * Get all pending operations.
   */
  async getPendingOperations(): Promise<SendOperation[]> {
    return this.operationQueries.getPending();
  }

  /**
   * Get all prepared operations.
   */
  async getPreparedOperations(): Promise<PreparedSendOperation[]> {
    const ops = await this.operationQueries.getByState('prepared');
    return ops.filter((op): op is PreparedSendOperation => op.state === 'prepared');
  }
}
