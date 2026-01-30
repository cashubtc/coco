import type { Token } from '@cashu/cashu-ts';
import type { SendOperationService } from '../operations/send/SendOperationService';
import type {
  SendOperation,
  PreparedSendOperation,
  PendingSendOperation,
  CreateSendOperationOptions,
} from '../operations/send/SendOperation';
import type { SendMethod, SendMethodData } from '../operations/send/SendMethodHandler';

/**
 * API for managing send operations.
 *
 * Provides methods to:
 * - Query pending send operations
 * - Rollback or finalize operations by operationId
 * - Recover pending operations on startup
 */
export class SendApi {
  private readonly sendOperationService: SendOperationService;

  constructor(sendOperationService: SendOperationService) {
    this.sendOperationService = sendOperationService;
  }

  /**
   * Prepare a send operation without executing it.
   * This reserves the proofs and calculates the fee.
   *
   * Use this when you want to show the user the fee before committing.
   * The returned operation contains:
   * - `fee`: The swap fee (0 if exact match)
   * - `needsSwap`: Whether a swap is required
   * - `inputAmount`: Total input proof amount
   *
   * After reviewing, call `executePreparedSend()` to execute, or `rollback()` to cancel.
   *
   * @param mintUrl - The mint URL to send from
   * @param amount - The amount to send
   * @returns The prepared operation with fee information
   */
  async prepareSend(mintUrl: string, amount: number): Promise<PreparedSendOperation> {
    const initOp = await this.sendOperationService.init(mintUrl, amount);
    return this.sendOperationService.prepare(initOp);
  }

  /**
   * Prepare a P2PK (Pay-to-Public-Key) send operation.
   * Creates tokens that are locked to a specific public key and can only be
   * redeemed by the holder of the corresponding private key.
   *
   * Use this when you want to send tokens to a specific recipient identified
   * by their public key. The recipient must sign the proofs with their private
   * key to redeem them.
   *
   * @param mintUrl - The mint URL to send from
   * @param amount - The amount to send
   * @param pubkey - The recipient's public key (hex-encoded, 33 bytes compressed)
   * @returns The prepared operation with fee information
   */
  async prepareSendP2pk(
    mintUrl: string,
    amount: number,
    pubkey: string,
  ): Promise<PreparedSendOperation> {
    const initOp = await this.sendOperationService.init(mintUrl, amount, {
      method: 'p2pk',
      methodData: { pubkey },
    });
    return this.sendOperationService.prepare(initOp);
  }

  /**
   * Execute a prepared send operation.
   * Call this after `prepareSend()` to complete the send.
   *
   * @param operationId - The ID of the prepared operation
   * @returns The pending operation and the token to share
   * @throws If the operation is not in 'prepared' state
   */
  async executePreparedSend(
    operationId: string,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    const operation = await this.sendOperationService.getOperation(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }
    if (operation.state !== 'prepared') {
      throw new Error(
        `Cannot execute operation in state '${operation.state}'. Expected 'prepared'.`,
      );
    }
    return this.sendOperationService.execute(operation);
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
   * Recover all pending operations.
   * Should be called during application initialization.
   */
  async recoverPendingOperations(): Promise<void> {
    return this.sendOperationService.recoverPendingOperations();
  }

  /**
   * Check a pending operation and finalize it if it should be finalized.
   */
  async checkPendingOperation(operationId: string): Promise<void> {
    const operation = await this.sendOperationService.getOperation(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }
    if (operation.state !== 'pending') {
      throw new Error(`Operation ${operationId} is not in pending state`);
    }
    return this.sendOperationService.checkPendingOperation(operation);
  }

  /**
   * Check if a specific operation is currently locked (in progress).
   * Useful for UI to disable buttons while an operation is executing.
   */
  isOperationLocked(operationId: string): boolean {
    return this.sendOperationService.isOperationLocked(operationId);
  }

  /**
   * Check if recovery is currently in progress.
   * Useful to prevent multiple recovery calls.
   */
  isRecoveryInProgress(): boolean {
    return this.sendOperationService.isRecoveryInProgress();
  }
}
