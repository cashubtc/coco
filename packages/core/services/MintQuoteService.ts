import type { MintQuoteRepository } from '../repositories';
import type { WalletService } from './WalletService';
import type { ProofService } from './ProofService';
import type { MintQuoteResponse, MintQuoteState } from '@cashu/cashu-ts';
import type { CoreEvents, EventBus } from '@core/events';
import type { Logger } from '../logging/Logger.ts';

export class MintQuoteService {
  private readonly mintQuoteRepo: MintQuoteRepository;
  private readonly walletService: WalletService;
  private readonly proofService: ProofService;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  constructor(
    mintQuoteRepo: MintQuoteRepository,
    walletService: WalletService,
    proofService: ProofService,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.mintQuoteRepo = mintQuoteRepo;
    this.walletService = walletService;
    this.proofService = proofService;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  async createMintQuote(mintUrl: string, amount: number): Promise<MintQuoteResponse> {
    this.logger?.info('Creating mint quote', { mintUrl, amount });
    try {
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
      const quote = await wallet.createMintQuote(amount);
      await this.mintQuoteRepo.addMintQuote({ ...quote, mintUrl });
      await this.eventBus.emit('mint-quote:created', { mintUrl, quoteId: quote.quote, quote });
      this.logger?.info('Mint quote created', { mintUrl, quoteId: quote.quote });

      return quote;
    } catch (err) {
      this.logger?.error('Failed to create mint quote', { mintUrl, amount, err });
      throw err;
    }
  }

  async redeemMintQuote(mintUrl: string, quoteId: string): Promise<void> {
    this.logger?.info('Redeeming mint quote', { mintUrl, quoteId });
    try {
      const quote = await this.mintQuoteRepo.getMintQuote(mintUrl, quoteId);
      if (!quote) {
        this.logger?.warn('Mint quote not found', { mintUrl, quoteId });
        throw new Error('Quote not found');
      }
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
      const { keep } = await this.proofService.createOutputsAndIncrementCounters(mintUrl, {
        keep: quote.amount,
        send: 0,
      });
      const proofs = await wallet.mintProofs(quote.amount, quote.quote, { outputData: keep });
      this.logger?.info('Mint quote redeemed, proofs minted', {
        mintUrl,
        quoteId,
        amount: quote.amount,
        proofs: proofs.length,
      });
      await this.setMintQuoteState(mintUrl, quoteId, 'ISSUED');
      await this.proofService.saveProofs(mintUrl, proofs);
      this.logger?.debug('Proofs saved to repository', { mintUrl, count: proofs.length });
    } catch (err) {
      this.logger?.error('Failed to redeem mint quote', { mintUrl, quoteId, err });
      throw err;
    }
  }

  private async setMintQuoteState(
    mintUrl: string,
    quoteId: string,
    state: MintQuoteState,
  ): Promise<void> {
    this.logger?.debug('Setting mint quote state', { mintUrl, quoteId, state });
    await this.mintQuoteRepo.setMintQuoteState(mintUrl, quoteId, state);
    await this.eventBus.emit('mint-quote:state-changed', { mintUrl, quoteId, state });
    this.logger?.debug('Mint quote state updated', { mintUrl, quoteId, state });
  }
}
