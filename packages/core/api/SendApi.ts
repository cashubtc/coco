import type { SendOperationService } from '../operations/send/SendOperationService';
import type { HistoryRepository } from '../repositories';
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
  private readonly historyRepository: HistoryRepository;

  constructor(sendOperationService: SendOperationService, historyRepository: HistoryRepository) {
    this.sendOperationService = sendOperationService;
    this.historyRepository = historyRepository;
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
  async finalizeByHistoryId(historyId: string, mintUrl: string): Promise<void> {
    const operationId = await this.getOperationIdFromHistoryId(historyId, mintUrl);
    return this.sendOperationService.finalize(operationId);
  }

  /**
   * Rollback a send operation by history entry ID.
   * Looks up the operationId from the history entry and rolls back.
   */
  async rollbackByHistoryId(historyId: string, mintUrl: string): Promise<void> {
    const operationId = await this.getOperationIdFromHistoryId(historyId, mintUrl);
    return this.sendOperationService.rollback(operationId);
  }

  /**
   * Recover all pending operations.
   * Should be called during application initialization.
   */
  async recoverPendingOperations(): Promise<void> {
    return this.sendOperationService.recoverPendingOperations();
  }

  /**
   * Helper to look up operationId from a history entry.
   */
  private async getOperationIdFromHistoryId(historyId: string, mintUrl: string): Promise<string> {
    // We need to find the history entry and extract the operationId
    // Since HistoryRepository doesn't have getById, we look up by iterating
    // TODO: Consider adding getHistoryEntryById to HistoryRepository
    const entries = await this.historyRepository.getPaginatedHistoryEntries(1000, 0);
    const entry = entries.find((e) => e.id === historyId && e.mintUrl === mintUrl);

    if (!entry) {
      throw new Error(`History entry ${historyId} not found`);
    }

    if (entry.type !== 'send') {
      throw new Error(`History entry ${historyId} is not a send entry`);
    }

    return entry.operationId;
  }
}
