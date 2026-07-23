import type { Token } from '@cashu/cashu-ts';
import type {
  DeferredReceiveOperation,
  FinalizedReceiveOperation,
  PreparedReceiveOperation,
  ReceiveOperation,
} from '../operations/receive/ReceiveOperation';
import type { ReceiveOperationService } from '../operations/receive/ReceiveOperationService';

export interface PrepareReceiveInput {
  /** Token to receive, either encoded or already decoded. */
  token: Token | string;
}

export interface ReceiveRecoveryApi {
  /** Runs the startup-style recovery sweep for receive operations. */
  run(): Promise<void>;
  /** Returns true while a recovery sweep is running. */
  inProgress(): boolean;
}

export interface ReceiveDiagnosticsApi {
  /** Returns true while an operation is currently locked by the service. */
  isLocked(operationId: string): boolean;
}

/**
 * Operation-oriented API for receive workflows.
 *
 * This API exposes receiving as an explicit lifecycle so callers can inspect,
 * resume, and cancel operations instead of relying only on a one-shot receive
 * call.
 */
export class ReceiveOpsApi {
  /** Recovery helpers for receive operations. */
  readonly recovery: ReceiveRecoveryApi = {
    run: async () => this.receiveOperationService.recoverPendingOperations(),
    inProgress: () => this.receiveOperationService.isRecoveryInProgress(),
  };

  /** Lightweight diagnostics for receive operations. */
  readonly diagnostics: ReceiveDiagnosticsApi = {
    isLocked: (operationId: string) => this.receiveOperationService.isOperationLocked(operationId),
  };

  constructor(private readonly receiveOperationService: ReceiveOperationService) {}

  /**
   * Decodes and validates a token, then prepares a receive operation without
   * executing it.
   *
   * Returns a deferred operation instead when the receive cannot be settled
   * yet (dust below the swap fee, or an unreachable mint); callers must branch
   * on `state` before executing.
   */
  async prepare(
    input: PrepareReceiveInput,
  ): Promise<PreparedReceiveOperation | DeferredReceiveOperation> {
    const initOp = await this.receiveOperationService.init(input.token);
    return this.receiveOperationService.prepare(initOp);
  }

  /**
   * Executes a prepared receive operation.
   *
   * Accepts either a prepared operation object or its ID. The latest operation
   * state is always reloaded before execution.
   */
  async execute(operationOrId: ReceiveOperation | string): Promise<FinalizedReceiveOperation> {
    const operation = await this.resolveOperation(operationOrId);
    if (operation.state !== 'prepared') {
      throw new Error(
        `Cannot execute operation in state '${operation.state}'. Expected 'prepared'.`,
      );
    }

    return this.receiveOperationService.execute(operation);
  }

  /** Returns a receive operation by ID, or `null` when it does not exist. */
  async get(operationId: string): Promise<ReceiveOperation | null> {
    return this.receiveOperationService.getOperation(operationId);
  }

  /** Lists receive operations that are prepared and ready to execute or cancel. */
  async listPrepared(): Promise<PreparedReceiveOperation[]> {
    return this.receiveOperationService.getPreparedOperations();
  }

  /** Lists receive operations queued for later redemption. */
  async listDeferred(): Promise<DeferredReceiveOperation[]> {
    return this.receiveOperationService.getDeferredOperations();
  }

  /**
   * Attempts to redeem deferred receive operations now, batched per mint and
   * unit. Groups that are still below the swap fee stay deferred. Useful when
   * connectivity returns; the recovery sweep also runs this automatically.
   */
  async redeemDeferred(filter?: { mintUrl?: string; unit?: string }): Promise<void> {
    return this.receiveOperationService.redeemDeferred(filter);
  }

  /** Lists receive operations that are currently in flight (executing or deferred). */
  async listInFlight(): Promise<ReceiveOperation[]> {
    return this.receiveOperationService.getPendingOperations();
  }

  /**
   * Re-checks a receive operation and returns its latest persisted state.
   *
   * Executing operations are actively recovered before the updated operation is
   * returned.
   */
  async refresh(operationId: string): Promise<ReceiveOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state === 'executing') {
      await this.receiveOperationService.recoverExecutingOperation(operation);
      return this.requireOperation(operationId);
    }

    return operation;
  }

  /**
   * Cancels a receive operation that has not completed yet.
   *
   * Only `init`, `prepared`, and `deferred` receive operations can be cancelled.
   */
  async cancel(operationId: string, reason?: string): Promise<void> {
    const operation = await this.requireOperation(operationId);
    if (
      operation.state !== 'init' &&
      operation.state !== 'prepared' &&
      operation.state !== 'deferred'
    ) {
      throw new Error(
        `Cannot cancel operation in state '${operation.state}'. Expected 'init', 'prepared', or 'deferred'.`,
      );
    }

    await this.receiveOperationService.rollback(operation.id, reason);
  }

  private async resolveOperation(
    operationOrId: ReceiveOperation | string,
  ): Promise<ReceiveOperation> {
    if (typeof operationOrId === 'string') {
      return this.requireOperation(operationOrId);
    }

    return this.requireOperation(operationOrId.id);
  }

  private async requireOperation(operationId: string): Promise<ReceiveOperation> {
    const operation = await this.receiveOperationService.getOperation(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    return operation;
  }
}
