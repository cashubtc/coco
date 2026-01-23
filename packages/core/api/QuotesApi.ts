import type { MeltQuoteBolt11Response, MintQuoteBolt11Response } from '@cashu/cashu-ts';
import type {
  FinalizedMeltOperation,
  MeltOperationService,
  PendingMeltOperation,
  PendingCheckResult,
  PreparedMeltOperation,
} from '@core/operations/melt';
import type { MintQuoteService, MeltQuoteService } from '@core/services';

export class QuotesApi {
  private mintQuoteService: MintQuoteService;
  private meltQuoteService: MeltQuoteService;
  private meltOperationService: MeltOperationService;
  constructor(
    mintQuoteService: MintQuoteService,
    meltQuoteService: MeltQuoteService,
    meltOperationService: MeltOperationService,
  ) {
    this.mintQuoteService = mintQuoteService;
    this.meltQuoteService = meltQuoteService;
    this.meltOperationService = meltOperationService;
  }

  async createMintQuote(mintUrl: string, amount: number): Promise<MintQuoteBolt11Response> {
    return this.mintQuoteService.createMintQuote(mintUrl, amount);
  }

  async redeemMintQuote(mintUrl: string, quoteId: string): Promise<void> {
    return this.mintQuoteService.redeemMintQuote(mintUrl, quoteId);
  }

  /**
   * Create a bolt11 melt quote
   * @deprecated Use {@link prepareMeltBolt11} instead
   */
  async createMeltQuote(mintUrl: string, invoice: string): Promise<MeltQuoteBolt11Response> {
    return this.meltQuoteService.createMeltQuote(mintUrl, invoice);
  }

  /**
   * Pay a bolt11 melt quote
   * @deprecated Use {@link executeMeltBolt11} instead
   */
  async payMeltQuote(mintUrl: string, quoteId: string): Promise<void> {
    return this.meltQuoteService.payMeltQuote(mintUrl, quoteId);
  }

  async prepareMeltBolt11(mintUrl: string, invoice: string): Promise<PreparedMeltOperation> {
    const initOperation = await this.meltOperationService.init(mintUrl, 'bolt11', { invoice });
    const preparedOperation = await this.meltOperationService.prepare(initOperation.id);
    return preparedOperation;
  }

  async executeMelt(operationId: string): Promise<PendingMeltOperation | FinalizedMeltOperation> {
    return this.meltOperationService.execute(operationId);
  }

  async executeMeltByQuote(
    mintUrl: string,
    quoteId: string,
  ): Promise<PendingMeltOperation | FinalizedMeltOperation | null> {
    const operation = await this.meltOperationService.getOperationByQuote(mintUrl, quoteId);
    if (!operation) {
      return null;
    }

    return this.meltOperationService.execute(operation.id);
  }

  async checkPendingMelt(operationId: string): Promise<PendingCheckResult> {
    return this.meltOperationService.checkPendingOperation(operationId);
  }

  async checkPendingMeltByQuote(
    mintUrl: string,
    quoteId: string,
  ): Promise<PendingCheckResult | null> {
    const operation = await this.meltOperationService.getOperationByQuote(mintUrl, quoteId);
    if (!operation) {
      return null;
    }

    return this.meltOperationService.checkPendingOperation(operation.id);
  }

  async addMintQuote(
    mintUrl: string,
    quotes: MintQuoteBolt11Response[],
  ): Promise<{ added: string[]; skipped: string[] }> {
    return this.mintQuoteService.addExistingMintQuotes(mintUrl, quotes);
  }

  async requeuePaidMintQuotes(mintUrl?: string): Promise<{ requeued: string[] }> {
    return this.mintQuoteService.requeuePaidMintQuotes(mintUrl);
  }
}
