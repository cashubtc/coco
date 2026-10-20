import { type Proof, Mint, Wallet, sumProofs, type OutputDataCreator } from '@cashu/cashu-ts';
import { mapProofToCoreProof, normalizeMintUrl } from '@core/utils';
import type { ReceiveOpsApi } from '../api/ReceiveOpsApi.ts';
import type { SweepKeysetResult, SweepKeysetSummary } from '../models/Sweep.ts';
import type { CoreTransactionRunner } from '../transactions/CoreTransaction.ts';
import type { EventBus, CoreEvents } from '../events/index.ts';
import { applyRestoreResult } from '../operations/restore/RestoreTransitions.ts';
import type { Logger } from '../logging/Logger.ts';
import type { MintRequestProvider } from '../infra/MintRequestProvider.ts';
import { DEFAULT_UNIT, normalizeUnit } from '../amounts.ts';

export class WalletRestoreService {
  private readonly transactionRunner: CoreTransactionRunner;
  private readonly requestProvider: MintRequestProvider;
  private readonly logger?: Logger;
  private readonly outputDataCreator?: OutputDataCreator;

  // Defaults for batch restore behavior
  private readonly restoreGapLimit = 300;
  private readonly restoreBatchSize = 100;
  private readonly restoreStartCounter = 0;

  constructor(
    private readonly receive: Pick<ReceiveOpsApi, 'prepare' | 'execute' | 'get'>,
    transactionRunner: CoreTransactionRunner,
    requestProvider: MintRequestProvider,
    logger?: Logger,
    outputDataCreator?: OutputDataCreator,
    private readonly eventBus?: EventBus<CoreEvents>,
  ) {
    this.transactionRunner = transactionRunner;
    this.requestProvider = requestProvider;
    this.logger = logger;
    this.outputDataCreator = outputDataCreator;
  }

  /** Discover a source keyset and delegate its available value to public Receive operations. */
  async sweepKeyset(
    mintUrl: string,
    keysetId: string,
    bip39seed: Uint8Array,
    unit = DEFAULT_UNIT,
  ): Promise<SweepKeysetResult> {
    mintUrl = normalizeMintUrl(mintUrl);
    const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
    const summary: SweepKeysetSummary = { keysetId, unit: normalizedUnit };
    const sweepWallet = new Wallet(
      new Mint(mintUrl, { customRequest: this.requestProvider.getRequestFn(mintUrl) }),
      { bip39seed, unit: normalizedUnit, outputDataCreator: this.outputDataCreator },
    );
    await sweepWallet.loadMint();
    const { proofs } = await sweepWallet.batchRestore({
      gapLimit: this.restoreGapLimit,
      batchSize: this.restoreBatchSize,
      counter: this.restoreStartCounter,
      keysetId,
      filterSpent: false,
    });
    const states = proofs.length ? await sweepWallet.checkProofsStates(proofs) : [];
    if (
      !Array.isArray(states) ||
      states.length !== proofs.length ||
      states.some((state) => !state || !['UNSPENT', 'PENDING', 'SPENT'].includes(state.state))
    ) {
      throw new Error('Malformed state check');
    }
    const available: Proof[] = [];
    const pending: Proof[] = [];
    for (const [index, state] of states.entries()) {
      if (state.state === 'UNSPENT') available.push(proofs[index]!);
      if (state.state === 'PENDING') pending.push(proofs[index]!);
    }
    summary.pending = { count: pending.length, amount: sumProofs(pending) };
    if (!available.length) {
      return pending.length
        ? { ...summary, status: 'skipped', reason: 'pending' }
        : { ...summary, status: 'noop' };
    }
    let receiveOperationId: string | undefined;
    try {
      // Preflight only decides whether this is an economic transfer. Receive owns
      // authoritative fees, output allocation, settlement, and recovery.
      const amount = sumProofs(available);
      const fee = sweepWallet.getFeesForProofs(available);
      if (amount.lessThanOrEqual(fee)) {
        return { ...summary, status: 'skipped', reason: 'uneconomic', available: amount, fee };
      }
      const prepared = await this.receive.prepare({
        token: { mint: mintUrl, proofs: available, unit: normalizedUnit },
      });
      receiveOperationId = prepared.id;
      const finalized = await this.receive.execute(prepared.id);
      return {
        ...summary,
        status: 'transferred',
        receiveOperationId,
        received: finalized.amount.subtract(finalized.fee),
        fee: finalized.fee,
      };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (!receiveOperationId) return { ...summary, status: 'failed', error };
      // A rejected execute may already have settled during Receive recovery.
      // Read only: Sweep never submits a replacement for an uncertain exchange.
      const operation = await this.receive.get(receiveOperationId).catch(() => null);
      if (operation?.state === 'finalized') {
        return {
          ...summary,
          status: 'transferred',
          receiveOperationId,
          received: operation.amount.subtract(operation.fee),
          fee: operation.fee,
        };
      }
      return {
        ...summary,
        status: operation?.state === 'rolled_back' ? 'failed' : 'unresolved',
        receiveOperationId,
        error,
      };
    }
  }

  /** Restore a keyset additively, committing discovered proofs and its counter together. */
  async restoreKeyset(
    mintUrl: string,
    wallet: Wallet,
    keysetId: string,
    unit = DEFAULT_UNIT,
  ): Promise<void> {
    mintUrl = normalizeMintUrl(mintUrl);
    const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
    const { proofs, lastCounterWithSignature } = await wallet.batchRestore({
      gapLimit: this.restoreGapLimit,
      batchSize: this.restoreBatchSize,
      counter: this.restoreStartCounter,
      keysetId,
      filterSpent: false,
    });
    // All remote work completes before opening the local transaction.
    const states = proofs.length ? await wallet.checkProofsStates(proofs) : [];
    if (
      !Array.isArray(states) ||
      states.length !== proofs.length ||
      states.some((state) => !state || !['UNSPENT', 'PENDING', 'SPENT'].includes(state.state))
    ) {
      throw new Error('Malformed state check');
    }
    const candidates = proofs.flatMap((proof, index) =>
      mapProofToCoreProof(
        mintUrl,
        states[index]!.state === 'UNSPENT'
          ? 'ready'
          : states[index]!.state === 'PENDING'
            ? 'pending'
            : 'spent',
        [proof],
        { unit: normalizedUnit },
      ),
    );
    const nextCounter = lastCounterWithSignature == null ? 0 : lastCounterWithSignature + 1;
    if (
      lastCounterWithSignature != null &&
      (!Number.isSafeInteger(lastCounterWithSignature) || lastCounterWithSignature < 0)
    ) {
      throw new Error('Invalid restored output counter');
    }
    const result = await this.transactionRunner.run((tx) =>
      tx.perform(applyRestoreResult, {
        mintUrl,
        keysetId,
        proofs: candidates,
        nextCounter,
      }),
    );
    if (result.counter) await this.publishCommittedEvent('counter:updated', result.counter);
    if (result.inserted.length)
      await this.publishCommittedEvent('proofs:saved', {
        mintUrl,
        keysetId,
        proofs: result.inserted,
      });
    for (const proof of result.updated)
      await this.publishCommittedEvent('proofs:state-changed', {
        mintUrl,
        secrets: [proof.secret],
        state: proof.state,
      });
  }

  private async publishCommittedEvent<E extends keyof CoreEvents>(
    event: E,
    payload: CoreEvents[E],
  ): Promise<void> {
    try {
      await this.eventBus?.emit(event, payload, { throwOnError: true });
    } catch (error) {
      this.logger?.warn('Restore committed but event delivery failed', { event, error });
    }
  }
}
