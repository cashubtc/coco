import { Amount, type Keys, type Proof, type SerializedBlindedSignature } from '@cashu/cashu-ts';
import type { MeltOperationRepository, ProofRepository } from '../../repositories';
import type {
  ExecutingMeltOperation,
  FinalizedMeltOperation,
  InitMeltOperation,
  MeltMethodFinalizedData,
  MeltOperation,
  PendingMeltOperation,
  PreparedMeltOperation,
  RollingBackMeltOperation,
} from './MeltOperation';
import { hasPreparedData } from './MeltOperation';
import type {
  MeltMethod,
  MeltMethodData,
  MeltRemoteResult,
  PendingCheckResult,
} from './MeltMethodHandler';
import type { MintService } from '../../services/MintService';
import type { WalletService } from '../../services/WalletService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import {
  deserializeOutputData,
  generateSubId,
  getSecretsFromSerializedOutputData,
  normalizeMintUrl,
} from '../../utils';
import { ProofValidationError } from '../../models/Error';
import type { MintAdapter } from '@core/infra';
import type { MeltHandlerProvider } from '../../infra/handlers/melt';
import { MintScopedLock } from '../MintScopedLock';
import { OperationIdLock } from '../OperationIdLock';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle';
import { resolveOnchainMeltFeeOption, type MeltQuote } from '../../models/MeltQuote.ts';
import type { MeltQuoteRef, QuoteIdentity } from '../../models/QuoteIdentity.ts';
import type { CoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import {
  applyMeltPaidResult,
  applyMeltPending,
  applyMeltSwapResult,
  beginMeltExecution,
  cancelPreparedMelt,
  cleanupMeltInit,
  deferMeltRecovery,
  prepareMelt,
  releaseMeltAfterNonPayment,
} from './MeltTransitions.ts';
import { createKeyChain } from '../../proofs/KeysetSelection.ts';
import { restoreOutputProofs } from '../../infra/ProofRestore.ts';

type MeltOperationQueries = Pick<
  MeltOperationRepository,
  'getById' | 'getByQuoteId' | 'getByMintUrl' | 'getByState' | 'getPending'
>;
type MeltProofQueries = Pick<ProofRepository, 'getProofsBySecrets' | 'getProofsByOperationId'>;
type MeltQuoteLifecycle = Pick<
  QuoteLifecycle,
  | 'requireMeltQuoteRefForPrepare'
  | 'getMeltQuote'
  | 'getMeltQuoteById'
  | 'refreshMeltQuote'
  | 'refreshMeltQuoteById'
  | 'recordMeltQuoteObservation'
>;

export interface MeltOperationServiceDependencies {
  handlerProvider: MeltHandlerProvider;
  meltOperationQueries: MeltOperationQueries;
  proofQueries: MeltProofQueries;
  transactionRunner: CoreTransactionRunner;
  loadSeed: () => Promise<Uint8Array>;
  quoteLifecycle: MeltQuoteLifecycle;
  mintService: Pick<MintService, 'refreshAndCommitIfStale'>;
  walletService: Pick<WalletService, 'getWalletWithActiveKeysetId'>;
  mintAdapter: MintAdapter;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
  mintScopedLock?: MintScopedLock;
}

/** Coordinates committed local Melt transitions around remote protocol effects. */
export class MeltOperationService {
  private readonly operationIdLock = new OperationIdLock();
  private recoveryLock: Promise<void> | null = null;
  private readonly mintScopedLock: MintScopedLock;

  constructor(private readonly dependencies: MeltOperationServiceDependencies) {
    this.mintScopedLock = dependencies.mintScopedLock ?? new MintScopedLock();
  }

  isOperationLocked(operationId: string): boolean {
    return this.operationIdLock.isLocked(operationId);
  }

  isRecoveryInProgress(): boolean {
    return this.recoveryLock !== null;
  }

  async prepareExistingQuote(
    quoteRef: MeltQuoteRef,
    options: { feeIndex?: number } = {},
  ): Promise<PreparedMeltOperation> {
    const quote = await this.dependencies.quoteLifecycle.requireMeltQuoteRefForPrepare(quoteRef);
    return this.prepareResolvedQuote(quote, generateSubId(), options);
  }

  /** Prepares a legacy init row without creating any new intermediate init operation. */
  async prepare(operationId: string): Promise<PreparedMeltOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'init' || !operation.quoteId) {
      throw new Error(
        `Cannot prepare operation ${operationId}: expected quote-bound state 'init' but found '${operation.state}'`,
      );
    }
    const quote = await this.dependencies.quoteLifecycle.requireMeltQuoteRefForPrepare({
      mintUrl: operation.mintUrl,
      method: operation.method,
      quoteId: operation.quoteId,
    });
    const feeIndex =
      operation.method === 'onchain'
        ? (operation.methodData as MeltMethodData<'onchain'>).feeIndex
        : undefined;
    return this.prepareResolvedQuote(quote, operation.id, { feeIndex });
  }

  private async prepareResolvedQuote(
    quote: MeltQuote,
    operationId: string,
    options: { feeIndex?: number },
  ): Promise<PreparedMeltOperation> {
    const releaseMintLock = await this.mintScopedLock.acquire(quote.mintUrl);
    try {
      const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(quote.mintUrl);
      const activeKeys = createKeyChain(quote.mintUrl, quote.unit, metadata.keysets)
        .getCheapestKeyset()
        .toMintKeys();
      if (!activeKeys) throw new ProofValidationError('Active keyset is missing mint keys');
      const seed = await this.dependencies.loadSeed();
      const now = Date.now();
      const result = await this.dependencies.transactionRunner.run((tx) =>
        tx.perform(prepareMelt, {
          operationId,
          mintUrl: quote.mintUrl,
          method: quote.method,
          methodData: this.methodDataFromMeltQuote(quote, options),
          quoteId: quote.quoteId,
          unit: quote.unit,
          activeKeys,
          seed,
          now,
        }),
      );
      if (result.changed) {
        if (result.counter) await this.publishCommittedEvent('counter:updated', result.counter);
        await this.publishCommittedEvent('proofs:reserved', {
          mintUrl: result.operation.mintUrl,
          operationId: result.operation.id,
          secrets: result.operation.inputProofSecrets,
          amount: { amount: result.operation.inputAmount, unit: result.operation.unit },
        });
        await this.publishCommittedEvent('melt-op:prepared', {
          mintUrl: result.operation.mintUrl,
          operationId: result.operation.id,
          operation: result.operation,
        });
      }
      return result.operation;
    } finally {
      releaseMintLock();
    }
  }

  async execute(operationId: string): Promise<PendingMeltOperation | FinalizedMeltOperation> {
    while (this.operationIdLock.isLocked(operationId)) {
      await this.operationIdLock.waitForUnlock(operationId);
    }
    const operation = await this.requireOperation(operationId);
    if (operation.state === 'pending' || operation.state === 'finalized') return operation;
    if (operation.state === 'executing') {
      await this.recoverExecutingOperation(operation);
      const recovered = await this.requireOperation(operationId);
      if (recovered.state === 'pending' || recovered.state === 'finalized') return recovered;
      throw new Error(`Operation ${operationId} remains ${recovered.state} after recovery`);
    }
    return this.executePrepared(operationId);
  }

  private async executePrepared(
    operationId: string,
  ): Promise<PendingMeltOperation | FinalizedMeltOperation> {
    const releaseLock = await this.operationIdLock.acquire(operationId);
    try {
      const current = await this.dependencies.meltOperationQueries.getById(operationId);
      if (!current || current.state !== 'prepared') {
        throw new Error(
          `Cannot execute operation ${operationId}: expected state 'prepared' but found '${current?.state ?? 'not found'}'`,
        );
      }
      const authorizationNow = Date.now();
      const authorization = await this.dependencies.transactionRunner.run((tx) =>
        tx.perform(beginMeltExecution, { operationId, now: authorizationNow }),
      );
      if (!authorization.changed || authorization.operation.state !== 'executing') {
        throw new Error(`Melt operation ${operationId} could not be authorized`);
      }
      const executing = authorization.operation;
      await this.publishProofState(
        executing.mintUrl,
        authorization.inputProofs.map((proof) => proof.secret),
        'inflight',
      );
      let meltInputs = authorization.inputProofs;
      try {
        const handler = this.dependencies.handlerProvider.get(executing.method);
        const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
          executing.mintUrl,
          executing.unit,
        );
        if (executing.needsSwap) {
          const swapped = await handler.swap({
            operation: executing as any,
            wallet,
            inputProofs: meltInputs,
            logger: this.dependencies.logger,
          });
          const swapAppliedAt = Date.now();
          const applied = await this.dependencies.transactionRunner.run((tx) =>
            tx.perform(applyMeltSwapResult, {
              operation: executing,
              keepProofs: swapped.keep,
              sendProofs: swapped.send,
              now: swapAppliedAt,
            }),
          );
          await this.publishAppliedSwap(applied);
          meltInputs = applied.sendProofs;
        }
        const remote = await handler.melt({
          operation: executing as any,
          inputProofs: meltInputs,
          mintAdapter: this.dependencies.mintAdapter,
          logger: this.dependencies.logger,
        });
        const quote = await this.recordRemoteResult(executing, remote);
        return this.applyObservedQuote(executing, quote);
      } catch (error) {
        await this.defer(executing.id, error);
        throw error;
      }
    } finally {
      releaseLock();
    }
  }

  async finalize(
    operationId: string,
    options: { canonicalQuote?: MeltQuote } = {},
  ): Promise<{
    changeAmount?: Amount;
    effectiveFee?: Amount;
    finalizedData?: MeltMethodFinalizedData;
  }> {
    const releaseLock = await this.operationIdLock.acquire(operationId);
    try {
      const current = await this.requireOperation(operationId);
      if (current.state === 'finalized') return this.finalizeResult(current);
      if (current.state !== 'pending' && current.state !== 'executing') {
        throw new Error(`Cannot finalize operation in state ${current.state}`);
      }
      const quote =
        options.canonicalQuote ??
        (await this.dependencies.quoteLifecycle.refreshMeltQuote(
          current.mintUrl,
          current.method,
          current.quoteId,
        ));
      if (quote.state !== 'PAID') {
        throw new Error(`Cannot finalize operation from quote state ${quote.state}`);
      }
      return this.finalizeResult(await this.applyPaid(current, quote));
    } finally {
      releaseLock();
    }
  }

  async rollback(operationId: string, reason = 'Rolled back'): Promise<void> {
    const releaseLock = await this.operationIdLock.acquire(operationId);
    try {
      const operation = await this.requireOperation(operationId);
      if (operation.state === 'prepared') {
        const now = Date.now();
        const result = await this.dependencies.transactionRunner.run((tx) =>
          tx.perform(cancelPreparedMelt, { operationId, reason, now }),
        );
        if (result.changed) await this.publishRolledBack(result);
        return;
      }
      if (operation.state !== 'pending') {
        throw new Error(`Cannot rollback operation in state ${operation.state}`);
      }
      const quote = await this.dependencies.quoteLifecycle.refreshMeltQuote(
        operation.mintUrl,
        operation.method,
        operation.quoteId,
      );
      if (quote.state !== 'UNPAID') {
        throw new Error(`Cannot rollback pending operation: quote state is ${quote.state}`);
      }
      await this.releaseAfterNonPayment(operation, quote, reason);
    } finally {
      releaseLock();
    }
  }

  async checkPendingOperation(operationId: string): Promise<PendingCheckResult> {
    const releaseLock = await this.operationIdLock.acquire(operationId);
    try {
      const operation = await this.requireOperation(operationId);
      if (operation.state !== 'pending') {
        throw new Error(
          `Cannot check operation ${operationId}: expected state 'pending' but found '${operation.state}'`,
        );
      }
      const persistedQuote = await this.dependencies.quoteLifecycle.getMeltQuote(
        operation.mintUrl,
        operation.method,
        operation.quoteId,
      );
      if (persistedQuote?.state === 'PAID') {
        await this.applyPaid(operation, persistedQuote);
        return 'finalize';
      }
      const quote = await this.dependencies.quoteLifecycle.refreshMeltQuoteById({
        mintUrl: operation.mintUrl,
        quoteId: operation.quoteId,
      });
      if (quote.state === 'PAID') {
        await this.applyPaid(operation, quote);
        return 'finalize';
      }
      if (quote.state === 'UNPAID') {
        await this.releaseAfterNonPayment(operation, quote, 'Canonical quote is UNPAID');
        return 'rollback';
      }
      return 'stay_pending';
    } finally {
      releaseLock();
    }
  }

  async recoverPendingOperations(): Promise<void> {
    if (this.recoveryLock) throw new Error('Recovery is already in progress');
    let releaseRecovery!: () => void;
    this.recoveryLock = new Promise<void>((resolve) => (releaseRecovery = resolve));
    try {
      for (const operation of await this.dependencies.meltOperationQueries.getByState('init')) {
        await this.recoverInitOperation(operation as InitMeltOperation);
      }
      for (const operation of await this.dependencies.meltOperationQueries.getByState(
        'executing',
      )) {
        try {
          await this.recoverExecutingOperation(operation as ExecutingMeltOperation);
        } catch (error) {
          this.dependencies.logger?.warn('Melt execution remains ambiguous', {
            operationId: operation.id,
            error,
          });
        }
      }
      for (const operation of await this.dependencies.meltOperationQueries.getByState('pending')) {
        try {
          await this.checkPendingOperation(operation.id);
        } catch (error) {
          this.dependencies.logger?.warn('Pending Melt recovery deferred', {
            operationId: operation.id,
            error,
          });
        }
      }
      for (const operation of await this.dependencies.meltOperationQueries.getByState(
        'rolling_back',
      )) {
        try {
          const rolling = operation as RollingBackMeltOperation;
          const quote = await this.dependencies.quoteLifecycle.refreshMeltQuoteById({
            mintUrl: rolling.mintUrl,
            quoteId: rolling.quoteId,
          });
          if (quote.state === 'UNPAID') {
            await this.releaseAfterNonPayment(rolling, quote, 'Recovered legacy rollback');
          } else {
            await this.defer(rolling.id, new Error(`Legacy rollback quote is ${quote.state}`));
          }
        } catch (error) {
          await this.defer(operation.id, error);
        }
      }
    } finally {
      this.recoveryLock = null;
      releaseRecovery();
    }
  }

  async recoverExecutingOperation(
    operation: ExecutingMeltOperation,
    options: { skipLock?: boolean } = {},
  ): Promise<void> {
    const releaseLock = options.skipLock
      ? undefined
      : await this.operationIdLock.acquire(operation.id);
    try {
      const current = await this.dependencies.meltOperationQueries.getById(operation.id);
      if (!current || current.state !== 'executing') return;
      const quote = await this.dependencies.quoteLifecycle.refreshMeltQuoteById({
        mintUrl: current.mintUrl,
        quoteId: current.quoteId,
      });
      if (current.needsSwap) await this.recoverPreSwap(current, quote);
      else await this.applyRecoveryObservation(current, quote);
    } catch (error) {
      await this.defer(operation.id, error);
      throw error;
    } finally {
      releaseLock?.();
    }
  }

  async getOperation(operationId: string): Promise<MeltOperation | null> {
    return this.dependencies.meltOperationQueries.getById(operationId);
  }

  async getOperationByQuote(
    mintUrl: string,
    method: MeltMethod,
    quoteId: string,
  ): Promise<MeltOperation | null> {
    const operations = await this.dependencies.meltOperationQueries.getByQuoteId(
      normalizeMintUrl(mintUrl),
      quoteId,
    );
    const matching = operations.filter((op) => op.method === method && hasPreparedData(op));
    if (matching.length > 1) {
      throw new Error(`Found ${matching.length} melt operations for quote ${quoteId}`);
    }
    return matching[0] ?? null;
  }

  async getOperationByQuoteIdentity(identity: QuoteIdentity): Promise<MeltOperation | null> {
    const quote = await this.dependencies.quoteLifecycle.getMeltQuoteById(identity);
    return quote ? this.getOperationByQuote(quote.mintUrl, quote.method, quote.quoteId) : null;
  }

  async listOperationsByQuote(mintUrl: string, quoteId: string): Promise<MeltOperation[]> {
    const operations = await this.dependencies.meltOperationQueries.getByQuoteId(
      normalizeMintUrl(mintUrl),
      quoteId,
    );
    return operations.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  getPendingOperations(): Promise<MeltOperation[]> {
    return this.dependencies.meltOperationQueries.getPending();
  }

  async getPreparedOperations(): Promise<PreparedMeltOperation[]> {
    const operations = await this.dependencies.meltOperationQueries.getByState('prepared');
    return operations.filter((op): op is PreparedMeltOperation => op.state === 'prepared');
  }

  private methodDataFromMeltQuote(
    quote: MeltQuote,
    options: { feeIndex?: number },
  ): MeltMethodData {
    if (quote.method === 'bolt11') return { invoice: quote.request };
    if (quote.method === 'bolt12') return { offer: quote.request };
    const { feeIndex } = resolveOnchainMeltFeeOption(quote, options.feeIndex);
    return { address: quote.request, amountSats: quote.amount, feeIndex };
  }

  private async recordRemoteResult(
    operation: ExecutingMeltOperation,
    result: MeltRemoteResult,
  ): Promise<MeltQuote> {
    const existing = await this.dependencies.quoteLifecycle.getMeltQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    if (!existing) throw new Error(`Melt quote ${operation.quoteId} was not found`);
    const now = Date.now();
    const observation = {
      ...existing,
      state: result.status,
      change: result.change,
      lastObservedRemoteState: result.status,
      lastObservedRemoteStateAt: now,
      updatedAt: now,
      ...(operation.method === 'onchain'
        ? { outpoint: result.finalizedData?.outpoint }
        : { payment_preimage: result.finalizedData?.preimage }),
    } as MeltQuote;
    return this.dependencies.quoteLifecycle.recordMeltQuoteObservation(observation);
  }

  private async applyObservedQuote(
    operation: ExecutingMeltOperation,
    quote: MeltQuote,
  ): Promise<PendingMeltOperation | FinalizedMeltOperation> {
    if (quote.state === 'PAID') return this.applyPaid(operation, quote);
    if (quote.state === 'PENDING') return this.applyPending(operation);
    if (quote.state === 'UNPAID') {
      await this.releaseAfterNonPayment(operation, quote, 'Melt response was UNPAID');
      throw new Error('Melt was not paid');
    }
    throw new Error(`Unsupported Melt quote state ${String(quote.state)}`);
  }

  private async applyPending(operation: ExecutingMeltOperation): Promise<PendingMeltOperation> {
    const now = Date.now();
    const result = await this.dependencies.transactionRunner.run((tx) =>
      tx.perform(applyMeltPending, { operation, now }),
    );
    if (result.operation.state !== 'pending') throw new Error('Melt did not enter pending state');
    if (result.changed) {
      await this.publishCommittedEvent('melt-op:pending', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: result.operation,
      });
    }
    return result.operation;
  }

  private async applyPaid(
    operation: ExecutingMeltOperation | PendingMeltOperation,
    quote: MeltQuote,
  ): Promise<FinalizedMeltOperation> {
    const proofs = await this.unblindChange(operation, quote.change ?? []);
    const finalizedData =
      quote.method === 'onchain'
        ? ({ outpoint: quote.outpoint } as MeltMethodFinalizedData)
        : ({ preimage: quote.payment_preimage ?? undefined } as MeltMethodFinalizedData);
    const now = Date.now();
    const result = await this.dependencies.transactionRunner.run((tx) =>
      tx.perform(applyMeltPaidResult, {
        operation,
        changeProofs: proofs,
        finalizedData,
        now,
      }),
    );
    if (result.changed) {
      await this.publishProofState(operation.mintUrl, result.spentInputSecrets, 'spent');
      await this.publishSavedProofs(operation.mintUrl, result.changeProofs);
      await this.publishCommittedEvent('melt-op:finalized', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: result.operation,
      });
    }
    return result.operation;
  }

  private async unblindChange(
    operation: ExecutingMeltOperation | PendingMeltOperation,
    signatures: SerializedBlindedSignature[],
  ): Promise<Proof[]> {
    if (signatures.length === 0) return [];
    const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(operation.mintUrl);
    const outputs = deserializeOutputData(operation.changeOutputData).keep;
    if (signatures.length > outputs.length) {
      throw new ProofValidationError('Mint returned more change signatures than allocated outputs');
    }
    return signatures.map((signature, index) => {
      const output = outputs[index];
      const keyset = metadata.keysets.find((candidate) => candidate.id === signature.id);
      if (!output || !keyset) throw new ProofValidationError('Melt change keyset is unavailable');
      return output.toProof(signature, { id: keyset.id, keys: keyset.keypairs as Keys });
    });
  }

  private async releaseAfterNonPayment(
    operation: ExecutingMeltOperation | PendingMeltOperation | RollingBackMeltOperation,
    quote: MeltQuote,
    reason: string,
    originalProofsUnspent = false,
  ): Promise<void> {
    if (quote.state !== 'UNPAID' || quote.lastObservedRemoteStateAt === undefined) {
      throw new Error('Fresh UNPAID evidence is required before releasing Melt proofs');
    }
    const now = Date.now();
    const result = await this.dependencies.transactionRunner.run((tx) =>
      tx.perform(releaseMeltAfterNonPayment, {
        operationId: operation.id,
        evidence: {
          kind: 'quote-observation-unpaid',
          mintUrl: operation.mintUrl,
          method: operation.method,
          quoteId: operation.quoteId,
          observedAt: quote.lastObservedRemoteStateAt!,
          originalProofsUnspent,
        },
        reason,
        now,
      }),
    );
    if (result.changed) await this.publishRolledBack(result);
  }

  private async recoverPreSwap(operation: ExecutingMeltOperation, quote: MeltQuote): Promise<void> {
    if (!operation.swapOutputData) throw new Error('Melt pre-swap plan is missing');
    const { sendSecrets } = getSecretsFromSerializedOutputData(operation.swapOutputData);
    const stored = await this.dependencies.proofQueries.getProofsBySecrets(
      operation.mintUrl,
      sendSecrets,
    );
    if (stored.length === sendSecrets.length) {
      await this.applyRecoveryObservation(operation, quote);
      return;
    }
    if (stored.length !== 0) throw new Error('Pre-swap recovery found partial outputs');
    const originals = await this.dependencies.proofQueries.getProofsBySecrets(
      operation.mintUrl,
      operation.inputProofSecrets,
    );
    const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
      operation.mintUrl,
      operation.unit,
    );
    const states = await wallet.checkProofsStates(originals);
    if (states.length === originals.length && states.every((state) => state.state === 'UNSPENT')) {
      if (quote.state !== 'UNPAID') {
        throw new Error('Melt quote advanced although pre-swap inputs are unspent');
      }
      await this.releaseAfterNonPayment(
        operation,
        quote,
        'Pre-swap inputs are confirmed unspent',
        true,
      );
      return;
    }
    const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(operation.mintUrl);
    const restored = await restoreOutputProofs(
      wallet,
      metadata.keysets,
      operation.unit,
      operation.swapOutputData,
    );
    const outputData = deserializeOutputData(operation.swapOutputData);
    const keepSecrets = new Set(
      outputData.keep.map((output) => new TextDecoder().decode(output.secret)),
    );
    const sendSecretSet = new Set(sendSecrets);
    const keep = restored.filter((proof) => keepSecrets.has(proof.secret));
    const send = restored.filter((proof) => sendSecretSet.has(proof.secret));
    if (keep.length + send.length !== outputData.keep.length + outputData.send.length) {
      throw new Error('Pre-swap outcome remains ambiguous; restored output set is incomplete');
    }
    const swapAppliedAt = Date.now();
    const applied = await this.dependencies.transactionRunner.run((tx) =>
      tx.perform(applyMeltSwapResult, {
        operation,
        keepProofs: keep,
        sendProofs: send,
        now: swapAppliedAt,
      }),
    );
    await this.publishAppliedSwap(applied);
    await this.applyRecoveryObservation(operation, quote);
  }

  private async applyRecoveryObservation(
    operation: ExecutingMeltOperation,
    quote: MeltQuote,
  ): Promise<void> {
    if (quote.state === 'PAID') {
      await this.applyPaid(operation, quote);
      return;
    }
    if (quote.state === 'PENDING') {
      await this.applyPending(operation);
      return;
    }
    await this.releaseAfterNonPayment(operation, quote, 'Recovered Melt as UNPAID');
  }

  private async recoverInitOperation(operation: InitMeltOperation): Promise<void> {
    const result = await this.dependencies.transactionRunner.run((tx) =>
      tx.perform(cleanupMeltInit, operation.id),
    );
    if (result.changed && result.releasedSecrets.length > 0) {
      await this.publishCommittedEvent('proofs:released', {
        mintUrl: operation.mintUrl,
        secrets: result.releasedSecrets,
      });
    }
  }

  private async defer(operationId: string, error: unknown): Promise<void> {
    try {
      const now = Date.now();
      await this.dependencies.transactionRunner.run((tx) =>
        tx.perform(deferMeltRecovery, {
          operationId,
          error: error instanceof Error ? error.message : String(error),
          now,
        }),
      );
    } catch (deferError) {
      this.dependencies.logger?.warn('Failed to persist deferred Melt recovery', {
        operationId,
        error: deferError,
      });
    }
  }

  private async requireOperation(operationId: string): Promise<MeltOperation> {
    const operation = await this.dependencies.meltOperationQueries.getById(operationId);
    if (!operation) throw new Error(`Operation ${operationId} not found`);
    return operation;
  }

  private finalizeResult(operation: FinalizedMeltOperation) {
    return {
      changeAmount: operation.changeAmount,
      effectiveFee: operation.effectiveFee,
      finalizedData: operation.finalizedData,
    };
  }

  private async publishRolledBack(result: {
    operation: MeltOperation;
    restoredSecrets: string[];
    releasedSecrets: string[];
  }): Promise<void> {
    await this.publishProofState(result.operation.mintUrl, result.restoredSecrets, 'ready');
    if (result.releasedSecrets.length > 0) {
      await this.publishCommittedEvent('proofs:released', {
        mintUrl: result.operation.mintUrl,
        secrets: result.releasedSecrets,
      });
    }
    await this.publishCommittedEvent('melt-op:rolled-back', {
      mintUrl: result.operation.mintUrl,
      operationId: result.operation.id,
      operation: result.operation,
    });
  }

  private async publishAppliedSwap(result: {
    operation: ExecutingMeltOperation;
    savedProofs: import('@core/types.ts').CoreProof[];
    spentInputSecrets: string[];
    changed: boolean;
  }): Promise<void> {
    if (!result.changed) return;
    await this.publishProofState(result.operation.mintUrl, result.spentInputSecrets, 'spent');
    await this.publishSavedProofs(result.operation.mintUrl, result.savedProofs);
  }

  private async publishSavedProofs(
    mintUrl: string,
    proofs: import('@core/types.ts').CoreProof[],
  ): Promise<void> {
    const grouped = new Map<string, typeof proofs>();
    for (const proof of proofs) grouped.set(proof.id, [...(grouped.get(proof.id) ?? []), proof]);
    for (const [keysetId, group] of grouped) {
      await this.publishCommittedEvent('proofs:saved', { mintUrl, keysetId, proofs: group });
    }
  }

  private async publishProofState(
    mintUrl: string,
    secrets: string[],
    state: 'inflight' | 'ready' | 'spent',
  ): Promise<void> {
    if (secrets.length === 0) return;
    await this.publishCommittedEvent('proofs:state-changed', { mintUrl, secrets, state });
  }

  private async publishCommittedEvent<E extends keyof CoreEvents>(
    event: E,
    payload: CoreEvents[E],
  ): Promise<void> {
    try {
      await this.dependencies.eventBus.emit(event, payload, { throwOnError: true });
    } catch (error) {
      this.dependencies.logger?.warn('Melt event listener failed after commit', { event, error });
    }
  }
}
