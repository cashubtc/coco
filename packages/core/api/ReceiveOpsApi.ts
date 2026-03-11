import type { Token } from '@cashu/cashu-ts';
import type {
  FinalizedReceiveOperation,
  PreparedReceiveOperation,
  ReceiveOperation,
} from '../operations/receive/ReceiveOperation';
import type { ReceiveOperationService } from '../operations/receive/ReceiveOperationService';
import { ReceiveApi } from './ReceiveApi';

export interface PrepareReceiveInput {
  token: Token | string;
}

export interface ReceiveRecoveryApi {
  run(): Promise<void>;
  inProgress(): boolean;
}

export interface ReceiveDiagnosticsApi {
  isLocked(operationId: string): boolean;
}

export class ReceiveOpsApi extends ReceiveApi {
  readonly recovery: ReceiveRecoveryApi = {
    run: async () => this.receiveOperationService.recoverPendingOperations(),
    inProgress: () => this.receiveOperationService.isRecoveryInProgress(),
  };

  readonly diagnostics: ReceiveDiagnosticsApi = {
    isLocked: (operationId: string) => this.receiveOperationService.isOperationLocked(operationId),
  };

  constructor(receiveOperationService: ReceiveOperationService) {
    super(receiveOperationService);
  }

  async prepare(input: PrepareReceiveInput): Promise<PreparedReceiveOperation> {
    const initOp = await this.receiveOperationService.init(input.token);
    return this.receiveOperationService.prepare(initOp);
  }

  async execute(operationOrId: ReceiveOperation | string): Promise<FinalizedReceiveOperation> {
    const operation = await this.resolveOperation(operationOrId);
    if (operation.state !== 'prepared') {
      throw new Error(
        `Cannot execute operation in state '${operation.state}'. Expected 'prepared'.`,
      );
    }

    return this.receiveOperationService.execute(operation);
  }

  async get(operationId: string): Promise<ReceiveOperation | null> {
    return this.receiveOperationService.getOperation(operationId);
  }

  async listPrepared(): Promise<PreparedReceiveOperation[]> {
    return this.receiveOperationService.getPreparedOperations();
  }

  async listInFlight(): Promise<ReceiveOperation[]> {
    return this.receiveOperationService.getPendingOperations();
  }

  /**
   * @deprecated Use `listPrepared()` or `listInFlight()` instead.
   * This alias will be removed in a future release.
   */
  async listActive(): Promise<ReceiveOperation[]> {
    const [prepared, inFlight] = await Promise.all([this.listPrepared(), this.listInFlight()]);
    return [...prepared, ...inFlight];
  }

  async refresh(operationId: string): Promise<ReceiveOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state === 'executing') {
      await this.receiveOperationService.recoverExecutingOperation(operation);
      return this.requireOperation(operationId);
    }

    return operation;
  }

  async cancel(operationId: string, reason?: string): Promise<void> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'init' && operation.state !== 'prepared') {
      throw new Error(
        `Cannot cancel operation in state '${operation.state}'. Expected 'init' or 'prepared'.`,
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
