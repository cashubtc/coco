import {
  Mint,
  Wallet,
  sumProofs,
  type OutputConfig,
  type OutputDataCreator,
} from '@cashu/cashu-ts';
import { mapProofToCoreProof, normalizeMintUrl } from '@core/utils';
import type { ProofService } from './ProofService';
import type { CoreTransactionRunner } from '../transactions/CoreTransaction.ts';
import type { CoreEvents, EventBus } from '../events/index.ts';
import { observeRestoredProofs } from '../proofs/RestoredProofs.ts';
import { applyRestoredKeyset } from './WalletRestoreTransitions.ts';
import type { Logger } from '../logging/Logger.ts';
import type { WalletService } from './WalletService.ts';
import type { MintRequestProvider } from '../infra/MintRequestProvider.ts';
import { DEFAULT_UNIT, normalizeUnit } from '../amounts.ts';

export class WalletRestoreService {
  private readonly proofService: ProofService;
  private readonly transactionRunner: CoreTransactionRunner;
  private readonly eventBus?: EventBus<CoreEvents>;
  private readonly walletService: WalletService;
  private readonly requestProvider: MintRequestProvider;
  private readonly logger?: Logger;
  private readonly outputDataCreator?: OutputDataCreator;

  // Defaults for batch restore behavior
  private readonly restoreGapLimit = 300;
  private readonly restoreBatchSize = 100;
  private readonly restoreStartCounter = 0;

  constructor(
    proofService: ProofService,
    transactionRunner: CoreTransactionRunner,
    walletService: WalletService,
    requestProvider: MintRequestProvider,
    logger?: Logger,
    outputDataCreator?: OutputDataCreator,
    eventBus?: EventBus<CoreEvents>,
  ) {
    this.proofService = proofService;
    this.transactionRunner = transactionRunner;
    this.eventBus = eventBus;
    this.walletService = walletService;
    this.requestProvider = requestProvider;
    this.logger = logger;
    this.outputDataCreator = outputDataCreator;
  }

  async sweepKeyset(
    mintUrl: string,
    keysetId: string,
    bip39seed: Uint8Array,
    unit = DEFAULT_UNIT,
  ): Promise<void> {
    mintUrl = normalizeMintUrl(mintUrl);
    const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
    this.logger?.debug('Sweeping keyset', { mintUrl, keysetId });
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
      mintUrl,
      normalizedUnit,
    );
    const requestFn = this.requestProvider.getRequestFn(mintUrl);
    const sweepWallet = new Wallet(new Mint(mintUrl, { customRequest: requestFn }), {
      bip39seed,
      unit: normalizedUnit,
      outputDataCreator: this.outputDataCreator,
    });
    await sweepWallet.loadMint();

    const { proofs } = await sweepWallet.batchRestore({
      gapLimit: this.restoreGapLimit,
      batchSize: this.restoreBatchSize,
      counter: this.restoreStartCounter,
      keysetId,
      filterSpent: false,
    });

    if (proofs.length === 0) {
      this.logger?.warn('No proofs to sweep', { mintUrl, keysetId });
      return;
    }

    this.logger?.debug('Proofs found for sweep', {
      mintUrl,
      keysetId,
      count: proofs.length,
    });

    const states = await sweepWallet.checkProofsStates(proofs);
    const observations = observeRestoredProofs(keysetId, proofs, states);
    const checkedProofs = {
      ready: observations.filter(({ state }) => state === 'UNSPENT').map(({ proof }) => proof),
      spent: observations.filter(({ state }) => state === 'SPENT').map(({ proof }) => proof),
    };

    this.logger?.debug('Checked proof states', {
      mintUrl,
      keysetId,
      ready: checkedProofs.ready.length,
      spent: checkedProofs.spent.length,
    });

    if (checkedProofs.ready.length === 0) {
      this.logger?.warn('No unspent proofs to sweep', {
        mintUrl,
        keysetId,
        spentCount: checkedProofs.spent.length,
      });
      return;
    }

    const sweepFee = sweepWallet.getFeesForProofs(checkedProofs.ready);
    const sweepAmount = sumProofs(checkedProofs.ready);

    if (sweepAmount.lessThanOrEqual(sweepFee)) {
      this.logger?.warn('Sweep amount is less than fee', {
        mintUrl,
        keysetId,
        amount: sweepAmount,
        fee: sweepFee,
      });
      return;
    }

    const sweepTotalAmount = sweepAmount.subtract(sweepFee);

    this.logger?.debug('Sweep calculation', {
      mintUrl,
      keysetId,
      amount: sweepAmount,
      fee: sweepFee,
      total: sweepTotalAmount,
    });

    const outputAmounts = {
      keep: { amount: sweepTotalAmount.subtract(sweepTotalAmount), unit: normalizedUnit },
      send: { amount: sweepTotalAmount, unit: normalizedUnit },
    };
    const outputResults = await this.proofService.createOutputsAndIncrementCounters(
      mintUrl,
      outputAmounts,
    );
    const outputConfig: OutputConfig = {
      send: { type: 'custom', data: outputResults.send },
      keep: { type: 'custom', data: outputResults.keep },
    };
    const { send, keep } = await wallet.send(
      sweepTotalAmount,
      checkedProofs.ready,
      undefined,
      outputConfig,
    );
    await this.proofService.saveProofs(
      mintUrl,
      mapProofToCoreProof(mintUrl, 'ready', [...keep, ...send], { unit: normalizedUnit }),
    );

    this.logger?.info('Keyset sweep completed', {
      mintUrl,
      keysetId,
      readyProofs: checkedProofs.ready.length,
      spentProofs: checkedProofs.spent.length,
      sweptAmount: sweepAmount,
      fee: sweepFee,
    });
  }

  /**
   * Restore one keyset atomically, preserving existing proofs and committed output positions.
   * Pending proofs are skipped; a later Restore can import them once positively unspent.
   */
  async restoreKeyset(
    mintUrl: string,
    wallet: Wallet,
    keysetId: string,
    unit = DEFAULT_UNIT,
  ): Promise<void> {
    mintUrl = normalizeMintUrl(mintUrl);
    const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
    this.logger?.debug('Restoring keyset', { mintUrl, keysetId });
    const { proofs, lastCounterWithSignature } = await wallet.batchRestore({
      gapLimit: this.restoreGapLimit,
      batchSize: this.restoreBatchSize,
      counter: this.restoreStartCounter,
      keysetId,
      filterSpent: false,
    });
    const states = proofs.length > 0 ? await wallet.checkProofsStates(proofs) : [];
    const observations = observeRestoredProofs(keysetId, proofs, states);
    const result = await this.transactionRunner.run((tx) =>
      tx.perform(applyRestoredKeyset, {
        mintUrl,
        keysetId,
        unit: normalizedUnit,
        observations,
        lastCounterWithSignature,
      }),
    );
    if (result.counter) await this.publishCommittedEvent('counter:updated', result.counter);
    if (result.proofs.length > 0) {
      await this.publishCommittedEvent('proofs:saved', {
        mintUrl,
        keysetId,
        proofs: result.proofs,
      });
    }
    this.logger?.info('Keyset restore completed', {
      mintUrl,
      keysetId,
      observed: observations.length,
      imported: result.proofs.length,
      pending: observations.filter(({ state }) => state === 'PENDING').length,
    });
  }

  private async publishCommittedEvent<E extends keyof CoreEvents>(
    event: E,
    payload: CoreEvents[E],
  ): Promise<void> {
    try {
      await this.eventBus?.emit(event, payload, { throwOnError: true });
    } catch (error) {
      this.logger?.warn('Restore event listener failed after commit', { event, error });
    }
  }
}
