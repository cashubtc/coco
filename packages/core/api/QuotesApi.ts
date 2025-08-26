import type { MintQuoteResponse } from '@cashu/cashu-ts';
import type { MintQuoteService } from '@core/services';

export class QuotesApi {
  private mintQuoteService: MintQuoteService;

  constructor(mintQuoteService: MintQuoteService) {
    this.mintQuoteService = mintQuoteService;
  }

  async createMintQuote(mintUrl: string, amount: number): Promise<MintQuoteResponse> {
    return this.mintQuoteService.createMintQuote(mintUrl, amount);
  }

  async redeemMintQuote(mintUrl: string, quoteId: string): Promise<void> {
    return this.mintQuoteService.redeemMintQuote(mintUrl, quoteId);
  }
}
