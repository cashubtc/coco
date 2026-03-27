import type { MeltQuoteBolt11Response } from '@cashu/cashu-ts';
import type {
  FinalizedMeltOperation,
  MeltOperation,
  MeltOperationService,
  PendingMeltOperation,
  PendingCheckResult,
  PreparedMeltOperation,
} from '@core/operations/melt';
import type { MeltQuoteService } from '@core/services';

export class QuotesApi {
  private meltQuoteService: MeltQuoteService;
  private meltOperationService: MeltOperationService;
  constructor(meltQuoteService: MeltQuoteService, meltOperationService: MeltOperationService) {
    this.meltQuoteService = meltQuoteService;
    this.meltOperationService = meltOperationService;
  }

  /**
   * Create a bolt11 melt quote.
   * @deprecated Use `manager.ops.melt.prepare({ mintUrl, method: 'bolt11', methodData: { invoice } })` instead.
   * This alias will be removed in a future release.
   */
  async createMeltQuote(mintUrl: string, invoice: string): Promise<MeltQuoteBolt11Response> {
    return this.meltQuoteService.createMeltQuote(mintUrl, invoice);
  }

  /**
   * Pay a bolt11 melt quote.
   * @deprecated Use `manager.ops.melt.execute()` instead.
   * This alias will be removed in a future release.
   */
  async payMeltQuote(mintUrl: string, quoteId: string): Promise<void> {
    return this.meltQuoteService.payMeltQuote(mintUrl, quoteId);
  }

  /**
   * @deprecated Use `manager.ops.melt.prepare({ mintUrl, method: 'bolt11', methodData: { invoice } })` instead.
   * This alias will be removed in a future release.
   */
  async prepareMeltBolt11(mintUrl: string, invoice: string): Promise<PreparedMeltOperation> {
    const initOperation = await this.meltOperationService.init(mintUrl, 'bolt11', { invoice });
    const preparedOperation = await this.meltOperationService.prepare(initOperation.id);
    return preparedOperation;
  }

  /**
   * @deprecated Use `manager.ops.melt.execute()` instead.
   * This alias will be removed in a future release.
   */
  async executeMelt(operationId: string): Promise<PendingMeltOperation | FinalizedMeltOperation> {
    return this.meltOperationService.execute(operationId);
  }

  /**
   * @deprecated Use `manager.ops.melt.getByQuote()` and `manager.ops.melt.execute()` instead.
   * This alias will be removed in a future release.
   */
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

  /**
   * @deprecated Use `manager.ops.melt.refresh()` instead.
   * This alias will be removed in a future release.
   */
  async checkPendingMelt(operationId: string): Promise<PendingCheckResult> {
    return this.meltOperationService.checkPendingOperation(operationId);
  }

  /**
   * @deprecated Use `manager.ops.melt.getByQuote()` and `manager.ops.melt.refresh()` instead.
   * This alias will be removed in a future release.
   */
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

  /**
   * @deprecated Use `manager.ops.melt.cancel()` for prepared operations or `manager.ops.melt.reclaim()` for pending operations instead.
   * This alias will be removed in a future release.
   *
   * Rollback (abort) a prepared melt operation.
   * Reclaims reserved proofs and cancels the operation.
   * Only works for operations in 'prepared' or 'pending' states.
   */
  async rollbackMelt(operationId: string, reason?: string): Promise<void> {
    return this.meltOperationService.rollback(operationId, reason);
  }

  /**
   * @deprecated Use `manager.ops.melt.get()` instead.
   * This alias will be removed in a future release.
   *
   * Get a melt operation by its ID.
   */
  async getMeltOperation(operationId: string): Promise<MeltOperation | null> {
    return this.meltOperationService.getOperation(operationId);
  }

  /**
   * @deprecated Use `manager.ops.melt.listInFlight()` instead.
   * This alias will be removed in a future release.
   *
   * Get all pending melt operations.
   * Pending operations are in 'executing' or 'pending' state.
   */
  async getPendingMeltOperations(): Promise<MeltOperation[]> {
    return this.meltOperationService.getPendingOperations();
  }

  /**
   * @deprecated Use `manager.ops.melt.listPrepared()` instead.
   * This alias will be removed in a future release.
   *
   * Get all prepared melt operations.
   * Prepared operations are ready to be executed or rolled back.
   */
  async getPreparedMeltOperations(): Promise<PreparedMeltOperation[]> {
    return this.meltOperationService.getPreparedOperations();
  }
}
