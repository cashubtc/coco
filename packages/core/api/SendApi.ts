import type { SendOperationService } from '../operations/send/SendOperationService';
import type { HistoryService } from '../services/HistoryService';
import type { SendOperation } from '../operations/send/SendOperation';

/**
 * API for managing send operations.
 *
 * Provides methods to:
 * - Query pending send operations
 * - Rollback or finalize operations (by operationId or historyId)
 * - Recover pending operations on startup
 */
export class SendApi {
  private readonly sendOperationService: SendOperationService;
  private readonly historyService: HistoryService;

  constructor(sendOperationService: SendOperationService, historyService: HistoryService) {
    this.sendOperationService = sendOperationService;
    this.historyService = historyService;
  }

  /**
   * Get a send operation by its ID.
   */
  async getOperation(operationId: string): Promise<SendOperation | null> {
    return this.sendOperationService.getOperation(operationId);
  }

  /**
   * Get all pending send operations.
   * Pending operations are in 'executing' or 'pending' state.
   */
  async getPendingOperations(): Promise<SendOperation[]> {
    return this.sendOperationService.getPendingOperations();
  }

  /**
   * Finalize a send operation by operationId.
   * This marks the operation as completed after proofs are confirmed spent.
   */
  async finalize(operationId: string): Promise<void> {
    return this.sendOperationService.finalize(operationId);
  }

  /**
   * Rollback a send operation by operationId.
   * Reclaims proofs and cancels the operation.
   */
  async rollback(operationId: string): Promise<void> {
    return this.sendOperationService.rollback(operationId);
  }

  /**
   * Finalize a send operation by history entry ID.
   * Looks up the operationId from the history entry and finalizes.
   */
  async finalizeByHistoryId(historyId: string): Promise<void> {
    const operationId = await this.historyService.getOperationIdFromHistoryEntry(historyId);
    return this.sendOperationService.finalize(operationId);
  }

  /**
   * Rollback a send operation by history entry ID.
   * Looks up the operationId from the history entry and rolls back.
   */
  async rollbackByHistoryId(historyId: string): Promise<void> {
    const operationId = await this.historyService.getOperationIdFromHistoryEntry(historyId);
    return this.sendOperationService.rollback(operationId);
  }

  /**
   * Recover all pending operations.
   * Should be called during application initialization.
   */
  async recoverPendingOperations(): Promise<void> {
    return this.sendOperationService.recoverPendingOperations();
  }
}
