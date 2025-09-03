import type { MeltQuoteResponse } from '@cashu/cashu-ts';
import type { Logger } from '../logging/Logger';
import type { ProofService } from './ProofService';
import type { WalletService } from './WalletService';
import type { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { MeltQuoteRepository } from '../repositories';
import { mapProofToCoreProof } from '@core/utils';

export class MeltQuoteService {
  private readonly proofService: ProofService;
  private readonly walletService: WalletService;
  private readonly meltQuoteRepo: MeltQuoteRepository;
  private readonly logger?: Logger;
  private readonly eventBus: EventBus<CoreEvents>;

  constructor(
    proofService: ProofService,
    walletService: WalletService,
    meltQuoteRepo: MeltQuoteRepository,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
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

    this.logger?.info('Paying melt quote', { mintUrl, quoteId });
    try {
      const quote = await this.meltQuoteRepo.getMeltQuote(mintUrl, quoteId);
      if (!quote) {
        this.logger?.warn('Melt quote not found', { mintUrl, quoteId });
        throw new Error('Quote not found');
      }
      const amountWithFee = quote.amount + quote.fee_reserve;
      const selectedProofs = await this.proofService.selectProofsToSend(mintUrl, amountWithFee);
      const selectedAmount = selectedProofs.reduce((acc, proof) => acc + proof.amount, 0);
      if (selectedAmount < amountWithFee) {
        this.logger?.warn('Insufficient proofs to cover melt amount with fee', {
          mintUrl,
          quoteId,
          required: amountWithFee,
          available: selectedAmount,
        });
        throw new Error('Insufficient proofs to pay melt quote');
      }
      const outputData = await this.proofService.createOutputsAndIncrementCounters(mintUrl, {
        keep: selectedAmount - amountWithFee,
        send: amountWithFee,
      });
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
      const { send, keep } = await wallet.send(amountWithFee, selectedProofs, { outputData });

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
      await wallet.meltProofs(quote, send);
      await this.proofService.setProofState(
        mintUrl,
        send.map((proof) => proof.secret),
        'spent',
      );
      await this.eventBus.emit('melt-quote:paid', { mintUrl, quoteId, quote });
    } catch (err) {
      this.logger?.error('Failed to pay melt quote', { mintUrl, quoteId, err });
      throw err;
    }
  }
}
