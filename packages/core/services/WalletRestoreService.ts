import {
  type Proof,
  Mint,
  Wallet,
  sumProofs,
  type OutputConfig,
  type OutputDataCreator,
} from '@cashu/cashu-ts';
import { mapProofToCoreProof, normalizeMintUrl } from '@core/utils';
import type { ProofService } from './ProofService';
import type { CoreTransactionRunner } from '../transactions/CoreTransaction.ts';
import type { EventBus, CoreEvents } from '../events/index.ts';
import { applyRestoreResult } from '../operations/restore/RestoreTransitions.ts';
import type { Logger } from '../logging/Logger.ts';
import type { WalletService } from './WalletService.ts';
import type { MintRequestProvider } from '../infra/MintRequestProvider.ts';
import { DEFAULT_UNIT, normalizeUnit } from '../amounts.ts';

export class WalletRestoreService {
  private readonly proofService: ProofService;
  private readonly transactionRunner: CoreTransactionRunner;
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
    private readonly eventBus?: EventBus<CoreEvents>,
  ) {
    this.proofService = proofService;
    this.transactionRunner = transactionRunner;
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
    if (!Array.isArray(states) || states.length !== proofs.length) {
      this.logger?.error('Malformed state check', {
        mintUrl,
        keysetId,
        statesLength: (states as unknown as { length?: number })?.length,
        proofsLength: proofs.length,
      });
      throw new Error('Malformed state check');
    }
    const checkedProofs: { spent: Proof[]; ready: Proof[] } = { spent: [], ready: [] };
    for (const [index, state] of states.entries()) {
      if (!proofs[index]) {
        this.logger?.error('Proof not found', { mintUrl, keysetId, index });
        throw new Error('Proof not found');
      }
      if (state.state === 'SPENT') {
        checkedProofs.spent.push(proofs[index]);
      } else {
        checkedProofs.ready.push(proofs[index]);
      }
    }

    this.logger?.debug('Checked proof states', {
      mintUrl,
      keysetId,
      ready: checkedProofs.ready.length,
      spent: checkedProofs.spent.length,
    });

    if (checkedProofs.ready.length === 0) {
      this.logger?.warn('No ready proofs to sweep, all spent', {
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
