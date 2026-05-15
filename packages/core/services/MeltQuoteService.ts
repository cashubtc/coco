import {
  sumProofs,
  type MeltQuoteBolt11Response,
  type MeltQuoteState,
  type OutputConfig,
} from '@cashu/cashu-ts';
import type { Logger } from '../logging/Logger';
import type { MintService } from './MintService';
import type { ProofService } from './ProofService';
import type { WalletService } from './WalletService';
import type { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { MeltQuoteRepository } from '../repositories';
import { mapProofToCoreProof } from '@core/utils';
import { UnknownMintError } from '../models/Error';
import { DEFAULT_UNIT, assertSameUnit, normalizeUnit, type UnitAmount } from '../amounts.ts';

export interface MeltQuoteOptions {
  unit?: string;
}

export class MeltQuoteService {
  private readonly mintService: MintService;
  private readonly proofService: ProofService;
  private readonly walletService: WalletService;
  private readonly meltQuoteRepo: MeltQuoteRepository;
  private readonly logger?: Logger;
  private readonly eventBus: EventBus<CoreEvents>;

  constructor(
    mintService: MintService,
    proofService: ProofService,
    walletService: WalletService,
    meltQuoteRepo: MeltQuoteRepository,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.mintService = mintService;
    this.proofService = proofService;
    this.walletService = walletService;
    this.meltQuoteRepo = meltQuoteRepo;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  async createMeltQuote(
    mintUrl: string,
    invoice: string,
    options: MeltQuoteOptions = {},
  ): Promise<MeltQuoteBolt11Response> {
    const unit = normalizeUnit(options.unit, { defaultUnit: DEFAULT_UNIT });
    if (!mintUrl || !mintUrl.trim()) {
      this.logger?.warn('Invalid parameter: mintUrl is required for createMeltQuote');
      throw new Error('mintUrl is required');
    }
    if (!invoice || !invoice.trim()) {
      this.logger?.warn('Invalid parameter: invoice is required for createMeltQuote', {
        mintUrl,
      });
      throw new Error('invoice is required');
    }

    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    await this.mintService.assertMintMethodUnitSupported(mintUrl, 5, 'bolt11', unit);

    this.logger?.info('Creating melt quote', { mintUrl, unit });
    try {
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl, unit);
      const quote = await wallet.createMeltQuoteBolt11(invoice);
      assertSameUnit(quote.unit, unit, `Melt quote ${quote.quote}`);
      const normalizedQuote = { ...quote, unit };
      await this.meltQuoteRepo.addMeltQuote({ ...normalizedQuote, mintUrl });
      await this.eventBus.emit('melt-quote:created', {
        mintUrl,
        quoteId: normalizedQuote.quote,
        quote: normalizedQuote,
      });
      return normalizedQuote;
    } catch (err) {
      this.logger?.error('Failed to create melt quote', { mintUrl, unit, err });
      throw err;
    }
  }

  async payMeltQuote(
    mintUrl: string,
    quoteId: string,
    options: MeltQuoteOptions = {},
  ): Promise<void> {
    if (!mintUrl || !mintUrl.trim()) {
      this.logger?.warn('Invalid parameter: mintUrl is required for payMeltQuote');
      throw new Error('mintUrl is required');
    }
    if (!quoteId || !quoteId.trim()) {
      this.logger?.warn('Invalid parameter: quoteId is required for payMeltQuote', { mintUrl });
      throw new Error('quoteId is required');
    }

    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    this.logger?.info('Paying melt quote', { mintUrl, quoteId });
    try {
      const quote = await this.meltQuoteRepo.getMeltQuote(mintUrl, quoteId);
      if (!quote) {
        this.logger?.warn('Melt quote not found', { mintUrl, quoteId });
        throw new Error('Quote not found');
      }
      const unit = normalizeUnit(quote.unit, { defaultUnit: DEFAULT_UNIT });
      if (options.unit !== undefined) {
        assertSameUnit(unit, options.unit, `Melt quote ${quoteId}`);
      }
      await this.mintService.assertMintMethodUnitSupported(mintUrl, 5, 'bolt11', unit);
      const scopedQuote = { ...quote, unit };
      const quoteAmount: UnitAmount = { amount: scopedQuote.amount, unit };
      const feeReserve: UnitAmount = { amount: scopedQuote.fee_reserve, unit };
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl, unit);

      let targetAmount = quoteAmount.amount.add(feeReserve.amount);
      const selectedProofs = await this.proofService.selectProofsToSend(mintUrl, {
        amount: targetAmount,
        unit,
      });
      const selectedInputFee = wallet.getFeesForProofs(selectedProofs);
      targetAmount = targetAmount.add(selectedInputFee);
      const selectedAmount = sumProofs(selectedProofs);
      if (selectedAmount.lessThan(targetAmount)) {
        this.logger?.warn('Insufficient proofs to cover melt amount with fee', {
          mintUrl,
          quoteId,
          required: targetAmount,
          available: selectedAmount,
        });
        throw new Error('Insufficient proofs to pay melt quote');
      }

      // If we have the exact amount, skip the send/swap operation
      if (selectedAmount.equals(targetAmount)) {
        this.logger?.debug('Exact amount match, skipping send/swap', {
          mintUrl,
          quoteId,
          amount: targetAmount,
        });
        await this.proofService.setProofState(
          mintUrl,
          selectedProofs.map((proof) => proof.secret),
          'inflight',
        );
        const { change } = await wallet.meltProofsBolt11(scopedQuote, selectedProofs);
        await this.proofService.saveProofs(
          mintUrl,
          mapProofToCoreProof(mintUrl, 'ready', change ?? [], { unit }),
        );
        await this.proofService.setProofState(
          mintUrl,
          selectedProofs.map((proof) => proof.secret),
          'spent',
        );
      } else {
        this.logger?.debug('Selected amount is greater than amount with fee, need to swap proofs', {
          mintUrl,
          quoteId,
          selectedAmount,
          targetAmount,
          selectedProofs,
        });
        const swapFees = wallet.getFeesForProofs(selectedProofs);
        const totalSendAmount = scopedQuote.amount.add(scopedQuote.fee_reserve).add(swapFees);
        if (selectedAmount.lessThan(totalSendAmount)) {
          this.logger?.warn('Insufficient proofs after fee calculation', {
            mintUrl,
            quoteId,
            selectedAmount,
            totalSendAmount,
            swapFees,
          });
          throw new Error('Insufficient proofs to pay melt quote after fees');
        }
        const sendAmount = scopedQuote.amount.add(scopedQuote.fee_reserve);
        const keepAmount = selectedAmount.subtract(sendAmount).subtract(swapFees);

        // Create deterministic blank outputs for receiving change and reserve counters
        const changeDelta = sendAmount.subtract(scopedQuote.amount);
        const blankOutputs = await this.proofService.createBlankOutputs(mintUrl, {
          amount: changeDelta,
          unit,
        });

        const outputData = await this.proofService.createOutputsAndIncrementCounters(
          mintUrl,
          {
            keep: { amount: keepAmount, unit },
            send: { amount: sendAmount, unit },
          },
          { includeFees: true },
        );
        const outputConfig: OutputConfig = {
          send: { type: 'custom', data: outputData.send },
          keep: { type: 'custom', data: outputData.keep },
        };

        const { send, keep } = await wallet.send(
          outputData.sendAmount,
          selectedProofs,
          undefined,
          outputConfig,
        );
        this.logger?.debug('Swapped successfully', {
          mintUrl,
          quoteId,
          send,
          keep,
        });

        await this.proofService.saveProofs(
          mintUrl,
          mapProofToCoreProof(mintUrl, 'ready', [...keep, ...send], { unit }),
        );
        await this.proofService.setProofState(
          mintUrl,
          selectedProofs.map((proof) => proof.secret),
          'spent',
        );
        await this.proofService.setProofState(
          mintUrl,
          send.map((proof) => proof.secret),
          'inflight',
        );

        const { change } = await wallet.meltProofsBolt11(scopedQuote, send, undefined, {
          type: 'custom',
          data: blankOutputs,
        });
        await this.proofService.saveProofs(
          mintUrl,
          mapProofToCoreProof(mintUrl, 'ready', change ?? [], { unit }),
        );
        await this.proofService.setProofState(
          mintUrl,
          send.map((proof) => proof.secret),
          'spent',
        );
      }
      await this.setMeltQuoteState(mintUrl, quoteId, 'PAID');
      await this.eventBus.emit('melt-quote:paid', { mintUrl, quoteId, quote: scopedQuote });
    } catch (err) {
      this.logger?.error('Failed to pay melt quote', { mintUrl, quoteId, err });
      throw err;
    }
  }

  private async setMeltQuoteState(
    mintUrl: string,
    quoteId: string,
    state: MeltQuoteState,
  ): Promise<void> {
    this.logger?.debug('Setting melt quote state', { mintUrl, quoteId, state });
    await this.meltQuoteRepo.setMeltQuoteState(mintUrl, quoteId, state);
    await this.eventBus.emit('melt-quote:state-changed', { mintUrl, quoteId, state });
    this.logger?.debug('Melt quote state updated', { mintUrl, quoteId, state });
  }
}
