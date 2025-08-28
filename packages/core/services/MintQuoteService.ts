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
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const quote = await wallet.createMintQuote(amount);
    await this.mintQuoteRepo.addMintQuote({ ...quote, mintUrl });
    await this.eventBus.emit('mint-quote:created', { mintUrl, quoteId: quote.quote, quote });

    return quote;
  }

  async redeemMintQuote(mintUrl: string, quoteId: string): Promise<void> {
    const quote = await this.mintQuoteRepo.getMintQuote(mintUrl, quoteId);
    if (!quote) {
      throw new Error('Quote not found');
    }
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const { keep } = await this.proofService.createOutputsAndIncrementCounters(mintUrl, {
      keep: quote.amount,
      send: 0,
    });
    const proofs = await wallet.mintProofs(quote.amount, quote.quote, { outputData: keep });
    await this.setMintQuoteState(mintUrl, quoteId, 'ISSUED');
    await this.proofService.saveProofs(mintUrl, proofs);
  }

  private async setMintQuoteState(
    mintUrl: string,
    quoteId: string,
    state: MintQuoteState,
  ): Promise<void> {
    await this.mintQuoteRepo.setMintQuoteState(mintUrl, quoteId, state);
    await this.eventBus.emit('mint-quote:state-changed', { mintUrl, quoteId, state });
  }
}
