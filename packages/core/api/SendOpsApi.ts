import type { Token } from '@cashu/cashu-ts';
import type {
  CreateSendOperationOptions,
  PendingSendOperation,
  PreparedSendOperation,
  SendOperation,
} from '../operations/send/SendOperation';
import type { SendMethod, SendMethodData } from '../operations/send/SendMethodHandler';
import type { SendOperationService } from '../operations/send/SendOperationService';

type NonDefaultSendMethod = Exclude<SendMethod, 'default'>;

export type SendTarget = {
  [M in NonDefaultSendMethod]: { type: M } & SendMethodData<M>;
}[NonDefaultSendMethod];

export interface PrepareSendInput {
  /** Mint to send from. */
  mintUrl: string;
  /** Amount to send in sats. */
  amount: number;
  /** Optional non-default send target, for example a P2PK recipient. */
  target?: SendTarget;
}

export interface SendRecoveryApi {
  /** Runs the startup-style recovery sweep for send operations. */
  run(): Promise<void>;
  /** Returns true while a recovery sweep is running. */
  inProgress(): boolean;
}

export interface SendDiagnosticsApi {
  /** Returns true while an operation is currently locked by the service. */
  isLocked(operationId: string): boolean;
}

/**
 * Operation-oriented API for send workflows.
 *
 * This API exposes the send lifecycle explicitly:
 * 1. `prepare()` to create and reserve inputs
 * 2. `execute()` to produce the outgoing token
 * 3. `refresh()` to re-check pending operations
 * 4. `cancel()` or `reclaim()` to roll back when allowed
 */
export class SendOpsApi {
  /** Recovery helpers for send operations. */
  readonly recovery: SendRecoveryApi = {
    run: async () => this.sendOperationService.recoverPendingOperations(),
    inProgress: () => this.sendOperationService.isRecoveryInProgress(),
  };

  /** Lightweight diagnostics for send operations. */
  readonly diagnostics: SendDiagnosticsApi = {
    isLocked: (operationId: string) => this.sendOperationService.isOperationLocked(operationId),
  };

  constructor(private readonly sendOperationService: SendOperationService) {}

  /**
   * Creates a prepared send operation without executing it.
   *
   * Use this to inspect the operation, fee impact, and target configuration
   * before producing the outgoing token.
   */
  async prepare(input: PrepareSendInput): Promise<PreparedSendOperation> {
    const initOp = await this.sendOperationService.init(
      input.mintUrl,
      input.amount,
      this.getCreateOptions(input.target),
    );
    return this.sendOperationService.prepare(initOp);
  }

  /**
   * Executes a prepared send operation and returns the shareable token.
   *
   * Accepts either a prepared operation object or its ID. The latest operation
   * state is always reloaded before execution.
   */
  async execute(
    operationOrId: SendOperation | string,
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    const operation = await this.resolveOperation(operationOrId);
    if (operation.state !== 'prepared') {
      throw new Error(
        `Cannot execute operation in state '${operation.state}'. Expected 'prepared'.`,
      );
    }

    return this.sendOperationService.execute(operation);
  }

  /** Returns a send operation by ID, or `null` when it does not exist. */
  async get(operationId: string): Promise<SendOperation | null> {
    return this.sendOperationService.getOperation(operationId);
  }

  /** Lists send operations that are prepared and ready to execute or cancel. */
  async listPrepared(): Promise<PreparedSendOperation[]> {
    return this.sendOperationService.getPreparedOperations();
  }

  /** Lists send operations that are currently in flight. */
  async listInFlight(): Promise<SendOperation[]> {
    return this.sendOperationService.getPendingOperations();
  }

  /**
   * Re-checks a send operation and returns its latest persisted state.
   *
   * Pending operations are actively checked with the service before the updated
   * operation is returned.
   */
  async refresh(operationId: string): Promise<SendOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state === 'pending') {
      await this.sendOperationService.checkPendingOperation(operation);
      return this.requireOperation(operationId);
    }

    return operation;
  }

  /**
   * Cancels a prepared send operation before it has been executed.
   */
  async cancel(operationId: string): Promise<void> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'prepared') {
      throw new Error(
        `Cannot cancel operation in state '${operation.state}'. Expected 'prepared'.`,
      );
    }

    await this.sendOperationService.rollback(operation.id);
  }

  /**
   * Attempts to reclaim a pending send operation.
   *
   * This is intended for sends that are already in flight but still support
   * rollback according to the underlying send method.
   */
  async reclaim(operationId: string): Promise<void> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'pending') {
      throw new Error(
        `Cannot reclaim operation in state '${operation.state}'. Expected 'pending'.`,
      );
    }

    await this.sendOperationService.rollback(operation.id);
  }

  /**
   * Finalizes a pending send operation explicitly.
   *
   * Most callers should rely on proof-state watchers when available, but this
   * method remains useful when the caller knows the token has been claimed.
   */
  async finalize(operationId: string): Promise<void> {
    await this.sendOperationService.finalize(operationId);
  }

  private getCreateOptions(target?: SendTarget): CreateSendOperationOptions {
    if (!target) {
      return {
        method: 'default',
        methodData: {},
      };
    }

    const { type, ...methodData } = target;
    return {
      method: type,
      methodData: methodData as SendMethodData<typeof type>,
    } as CreateSendOperationOptions;
  }

  private async resolveOperation(operationOrId: SendOperation | string): Promise<SendOperation> {
    if (typeof operationOrId === 'string') {
      return this.requireOperation(operationOrId);
    }

    return this.requireOperation(operationOrId.id);
  }

  private async requireOperation(operationId: string): Promise<SendOperation> {
    const operation = await this.sendOperationService.getOperation(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    return operation;
  }
}
