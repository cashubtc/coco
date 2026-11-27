import { type Proof, Mint, Wallet, sumProofs, type OutputDataCreator } from '@cashu/cashu-ts';
import { mapProofToCoreProof, normalizeMintUrl } from '@core/utils';
import type { ReceiveOperationService } from '../operations/receive/ReceiveOperationService.ts';
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

  // Restore scan defaults. The batch size is capped at the mint's advertised array limit.
  private readonly restoreGapLimit = 300;
  private readonly restoreBatchSize = 100;
  private readonly restoreStartCounter = 0;
  private readonly restoreRequestsInFlight = 4;

  constructor(
    private readonly receive: Pick<
      ReceiveOperationService,
      'init' | 'prepare' | 'execute' | 'getOperation'
    >,
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

  /**
   * Discover a source keyset and delegate its available value to the Receive coordinator.
   * Returns a result for discovery and exchange failures; callers must inspect its status.
   * Invalid mint URLs or units reject before discovery starts.
   */
  async sweepKeyset(
    mintUrl: string,
    keysetId: string,
    bip39seed: Uint8Array,
    unit = DEFAULT_UNIT,
  ): Promise<SweepKeysetResult> {
    mintUrl = normalizeMintUrl(mintUrl);
    const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
    const summary: SweepKeysetSummary = { keysetId, unit: normalizedUnit };
    let receiveOperationId: string | undefined;
    try {
      const sweepWallet = new Wallet(
        new Mint(mintUrl, { customRequest: this.requestProvider.getRequestFn(mintUrl) }),
        { bip39seed, unit: normalizedUnit, outputDataCreator: this.outputDataCreator },
      );
      await sweepWallet.loadMint();
      // Sweep uses only unspent and pending proofs, so cashu-ts's batch restore, which drops spent
      // ones, is enough here. It refuses a batch above the mint's advertised array limit.
      const { proofs } = await sweepWallet.batchRestore({
        gapLimit: this.restoreGapLimit,
        batchSize: this.restoreBatchSizeFor(sweepWallet),
        counter: this.restoreStartCounter,
        keysetId,
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
      // Preflight only decides whether this is an economic transfer. Receive owns
      // authoritative fees, output allocation, settlement, and recovery.
      const amount = sumProofs(available);
      const fee = sweepWallet.getFeesForProofs(available);
      if (amount.lessThanOrEqual(fee)) {
        return { ...summary, status: 'skipped', reason: 'uneconomic', available: amount, fee };
      }
      const draft = await this.receive.init({
        mint: mintUrl,
        proofs: available,
        unit: normalizedUnit,
      });
      const prepared = await this.receive.prepare(draft);
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
      const operation = await this.receive.getOperation(receiveOperationId).catch(() => null);
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

  /**
   * Restore a keyset additively, committing discovered proofs and its counter together. Local
   * proofs absent from the scan are left untouched and the counter is never lowered. Success means
   * the discovered results were applied, not that every historical output was found.
   */
  async restoreKeyset(
    mintUrl: string,
    wallet: Wallet,
    keysetId: string,
    unit = DEFAULT_UNIT,
  ): Promise<void> {
    mintUrl = normalizeMintUrl(mintUrl);
    const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
    const { proofs, lastCounterWithSignature } = await this.scanKeyset(wallet, keysetId);
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

  /** The restore batch size, within the array limit the mint advertises (NUT-06). */
  private restoreBatchSizeFor(wallet: Wallet): number {
    return Math.min(this.restoreBatchSize, wallet.getMintInfo().maxArrayLength);
  }

  /**
   * Scan the keyset's outputs in counter order until the gap limit of unissued counters. Spent
   * outputs are returned too: Restore needs them to correct stored proofs and to detect a conflict
   * with a stored proof. cashu-ts `batchRestore` drops them, so this uses the raw NUT-09 replay and
   * scans as `batchRestore` did before cashu-ts 5.0.0-rc.13: fixed waves of requests in flight,
   * every batch of a wave used, and a stop after enough empty batches in a row to cover the gap
   * limit.
   */
  private async scanKeyset(
    wallet: Wallet,
    keysetId: string,
  ): Promise<{ proofs: Proof[]; lastCounterWithSignature?: number }> {
    const batchSize = this.restoreBatchSizeFor(wallet);
    const proofs: Proof[] = [];
    let lastCounterWithSignature: number | undefined;
    let counter = this.restoreStartCounter;
    let emptyBatches = 0;
    const emptyBatchesToStop = Math.ceil(this.restoreGapLimit / batchSize);
    while (emptyBatches < emptyBatchesToStop) {
      const starts = Array.from(
        { length: this.restoreRequestsInFlight },
        (_, index) => counter + index * batchSize,
      );
      // Every batch of a wave is used, also one past the gap limit: its request is already sent.
      // A signed batch resets the count, also after empty batches earlier in the same wave.
      const wave = await Promise.all(
        starts.map((start) => wallet.restore(start, batchSize, { keysetId })),
      );
      for (const batch of wave) {
        if (batch.lastCounterWithSignature == null) {
          emptyBatches += 1;
          continue;
        }
        emptyBatches = 0;
        proofs.push(...batch.proofs);
        lastCounterWithSignature = batch.lastCounterWithSignature;
      }
      counter += starts.length * batchSize;
    }
    return { proofs, lastCounterWithSignature };
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
