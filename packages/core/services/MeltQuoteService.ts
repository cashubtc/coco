import type { MeltQuoteResponse, MeltQuoteState } from '@cashu/cashu-ts';
import type { Logger } from '../logging/Logger';
import type { MintService } from './MintService';
import type { ProofService } from './ProofService';
import type { WalletService } from './WalletService';
import type { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { MeltQuoteRepository } from '../repositories';
import { mapProofToCoreProof } from '@core/utils';
import { UnknownMintError } from '../models/Error';

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

  async createMeltQuote(mintUrl: string, invoice: string): Promise<MeltQuoteResponse> {
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

    this.logger?.info('Creating melt quote', { mintUrl });
    try {
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
      const quote = await wallet.createMeltQuote(invoice);
      await this.meltQuoteRepo.addMeltQuote({ ...quote, mintUrl });
      await this.eventBus.emit('melt-quote:created', { mintUrl, quoteId: quote.quote, quote });
      return quote;
    } catch (err) {
      this.logger?.error('Failed to create melt quote', { mintUrl, err });
      throw err;
    }
  }

  async payMeltQuote(mintUrl: string, quoteId: string): Promise<void> {
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
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);

      let targetAmount = quote.amount + quote.fee_reserve;
      const selectedProofs = await this.proofService.selectProofsToSend(mintUrl, targetAmount);
      const selectedInputFee = wallet.getFeesForProofs(selectedProofs);
      targetAmount = targetAmount + selectedInputFee;
      const selectedAmount = selectedProofs.reduce((acc, proof) => acc + proof.amount, 0);
      if (selectedAmount < targetAmount) {
        this.logger?.warn('Insufficient proofs to cover melt amount with fee', {
          mintUrl,
          quoteId,
          required: targetAmount,
          available: selectedAmount,
        });
        throw new Error('Insufficient proofs to pay melt quote');
      }

      // If we have the exact amount, skip the send/swap operation
      if (selectedAmount === targetAmount) {
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
        const { change } = await wallet.meltProofs(quote, selectedProofs);
        await this.proofService.saveProofs(mintUrl, mapProofToCoreProof(mintUrl, 'ready', change));
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
        const totalSendAmount = quote.amount + quote.fee_reserve + swapFees;
        if (selectedAmount < totalSendAmount) {
          this.logger?.warn('Insufficient proofs after fee calculation', {
            mintUrl,
            quoteId,
            selectedAmount,
            totalSendAmount,
            swapFees,
          });
          throw new Error('Insufficient proofs to pay melt quote after fees');
        }
        const outputData = await this.proofService.createOutputsAndIncrementCounters(
          mintUrl,
          {
            keep: selectedAmount - quote.amount - quote.fee_reserve - swapFees,
            send: quote.amount + quote.fee_reserve,
          },
          { includeFees: true },
        );
        const { send, keep } = await wallet.send(outputData.sendAmount, selectedProofs, {
          outputData,
        });
        this.logger?.debug('Swapped successfully', {
          mintUrl,
          quoteId,
          send,
          keep,
        });

        await this.proofService.saveProofs(
          mintUrl,
          mapProofToCoreProof(mintUrl, 'ready', [...keep, ...send]),
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
        const { change } = await wallet.meltProofs(quote, send);
        await this.proofService.saveProofs(mintUrl, mapProofToCoreProof(mintUrl, 'ready', change));
        await this.proofService.setProofState(
          mintUrl,
          send.map((proof) => proof.secret),
          'spent',
        );
      }
      await this.setMeltQuoteState(mintUrl, quoteId, 'PAID');
      await this.eventBus.emit('melt-quote:paid', { mintUrl, quoteId, quote });
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
