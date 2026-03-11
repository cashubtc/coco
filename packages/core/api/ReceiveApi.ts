import type {
  ReceiveOperation,
  PreparedReceiveOperation,
  FinalizedReceiveOperation,
} from '../operations/receive/ReceiveOperation';
import type { Token } from '@cashu/cashu-ts';
import type { ReceiveOperationService } from '../operations/receive/ReceiveOperationService';

/**
 * API for managing receive operations.
 *
 * Provides methods to:
 * - Prepare receive operations (review fees/amount)
 * - Execute prepared operations by operationId
 * - Inspect or recover pending/executing operations
 */
export class ReceiveApi {
  protected readonly receiveOperationService: ReceiveOperationService;

  constructor(receiveOperationService: ReceiveOperationService) {
    this.receiveOperationService = receiveOperationService;
  }

  /**
   * @deprecated Use `manager.ops.receive.prepare()` instead.
   * This alias will be removed in a future release.
   *
   * Prepare a receive operation without executing it.
   * Decodes the token, validates it, and calculates fees.
   *
   * Use this when you want to show the user the fee and amount before committing.
   * After reviewing, call `executeReceive()` to execute.
   *
   * @param token - The token to receive
   * @returns The prepared operation with fee information
   */
  async prepareReceive(token: Token | string): Promise<PreparedReceiveOperation> {
    const initOp = await this.receiveOperationService.init(token);
    return this.receiveOperationService.prepare(initOp);
  }

  /**
   * @deprecated Use `manager.ops.receive.execute()` instead.
   * This alias will be removed in a future release.
   *
   * Execute a prepared receive operation.
   * Call this after `prepareReceive()` to complete the receive.
   *
   * @param operationId - The ID of the prepared operation
   * @returns The finalized operation
   * @throws If the operation is not in 'prepared' state
   */
  async executeReceive(operationId: string): Promise<FinalizedReceiveOperation> {
    const operation = await this.receiveOperationService.getOperation(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }
    if (operation.state !== 'prepared') {
      throw new Error(
        `Cannot execute operation in state '${operation.state}'. Expected 'prepared'.`,
      );
    }

    return this.receiveOperationService.execute(operation);
  }

  /**
   * @deprecated Use `manager.ops.receive.get()` instead.
   * This alias will be removed in a future release.
   *
   * Get a receive operation by its ID.
   */
  async getOperation(operationId: string): Promise<ReceiveOperation | null> {
    return this.receiveOperationService.getOperation(operationId);
  }

  /**
   * @deprecated Use `manager.ops.receive.listInFlight()` instead.
   * This alias will be removed in a future release.
   *
   * Get all pending receive operations.
   * Pending operations are in 'executing' state.
   */
  async getPendingOperations(): Promise<ReceiveOperation[]> {
    return this.receiveOperationService.getPendingOperations();
  }

  /**
   * @deprecated Use `manager.ops.receive.finalize()` instead.
   * This alias will be removed in a future release.
   *
   * Finalize an executing receive operation by operationId.
   * This marks the operation as completed after proofs are confirmed saved.
   */
  async finalize(operationId: string): Promise<void> {
    return this.receiveOperationService.finalize(operationId);
  }

  /**
   * @deprecated Use `manager.ops.receive.recovery.run()` instead.
   * This alias will be removed in a future release.
   *
   * Recover all pending operations.
   * Should be called during application initialization.
   */
  async recoverPendingOperations(): Promise<void> {
    return this.receiveOperationService.recoverPendingOperations();
  }

  /**
   * @deprecated Use `manager.ops.receive.cancel()` instead.
   * This alias will be removed in a future release.
   *
   * Rollback (abort) a prepared receive operation.
   * Only works for operations in 'init' or 'prepared' state.
   */
  async rollbackReceive(operationId: string, reason?: string): Promise<void> {
    return this.receiveOperationService.rollback(operationId, reason);
  }

  /**
   * @deprecated Use `manager.ops.receive.refresh()` instead.
   * This alias will be removed in a future release.
   *
   * Check an executing operation and finalize it if it should be finalized.
   */
  async checkExecutingOperation(operationId: string): Promise<void> {
    const operation = await this.receiveOperationService.getOperation(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    if (operation.state !== 'executing') {
      throw new Error(
        `Cannot check operation in state '${operation.state}'. Expected 'executing'.`,
      );
    }

    return this.receiveOperationService.recoverExecutingOperation(operation);
  }

  /**
   * @deprecated Use `manager.ops.receive.diagnostics.isLocked()` instead.
   * This alias will be removed in a future release.
   *
   * Check if a specific operation is currently locked (in progress).
   * Useful for UI to disable buttons while an operation is executing.
   */
  isOperationLocked(operationId: string): boolean {
    return this.receiveOperationService.isOperationLocked(operationId);
  }

  /**
   * @deprecated Use `manager.ops.receive.recovery.inProgress()` instead.
   * This alias will be removed in a future release.
   *
   * Check if recovery is currently in progress.
   * Useful to prevent multiple recovery calls.
   */
  isRecoveryInProgress(): boolean {
    return this.receiveOperationService.isRecoveryInProgress();
  }
}
