import type { Token } from '@cashu/cashu-ts';
import type {
  CreateSendOperationOptions,
  PendingSendOperation,
  PreparedSendOperation,
  SendOperation,
} from '../operations/send/SendOperation';
import type { SendMethod, SendMethodData } from '../operations/send/SendMethodHandler';
import type { SendOperationService } from '../operations/send/SendOperationService';
import { SendApi } from './SendApi';

type NonDefaultSendMethod = Exclude<SendMethod, 'default'>;

export type SendTarget = {
  [M in NonDefaultSendMethod]: { type: M } & SendMethodData<M>;
}[NonDefaultSendMethod];

export interface PrepareSendInput {
  mintUrl: string;
  amount: number;
  target?: SendTarget;
}

export interface SendRecoveryApi {
  run(): Promise<void>;
  inProgress(): boolean;
}

export interface SendDiagnosticsApi {
  isLocked(operationId: string): boolean;
}

export class SendOpsApi extends SendApi {
  readonly recovery: SendRecoveryApi = {
    run: async () => this.sendOperationService.recoverPendingOperations(),
    inProgress: () => this.sendOperationService.isRecoveryInProgress(),
  };

  readonly diagnostics: SendDiagnosticsApi = {
    isLocked: (operationId: string) => this.sendOperationService.isOperationLocked(operationId),
  };

  constructor(sendOperationService: SendOperationService) {
    super(sendOperationService);
  }

  async prepare(input: PrepareSendInput): Promise<PreparedSendOperation> {
    const initOp = await this.sendOperationService.init(
      input.mintUrl,
      input.amount,
      this.getCreateOptions(input.target),
    );
    return this.sendOperationService.prepare(initOp);
  }

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

  async get(operationId: string): Promise<SendOperation | null> {
    return this.sendOperationService.getOperation(operationId);
  }

  async listPrepared(): Promise<PreparedSendOperation[]> {
    return this.sendOperationService.getPreparedOperations();
  }

  async listInFlight(): Promise<SendOperation[]> {
    return this.sendOperationService.getPendingOperations();
  }

  /**
   * @deprecated Use `listPrepared()` or `listInFlight()` instead.
   * This alias will be removed in a future release.
   */
  async listActive(): Promise<SendOperation[]> {
    const [prepared, inFlight] = await Promise.all([this.listPrepared(), this.listInFlight()]);
    return [...prepared, ...inFlight];
  }

  async refresh(operationId: string): Promise<SendOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state === 'pending') {
      await this.sendOperationService.checkPendingOperation(operation);
      return this.requireOperation(operationId);
    }

    return operation;
  }

  async cancel(operationId: string): Promise<void> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'prepared') {
      throw new Error(
        `Cannot cancel operation in state '${operation.state}'. Expected 'prepared'.`,
      );
    }

    await this.sendOperationService.rollback(operation.id);
  }

  async reclaim(operationId: string): Promise<void> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'pending') {
      throw new Error(
        `Cannot reclaim operation in state '${operation.state}'. Expected 'pending'.`,
      );
    }

    await this.sendOperationService.rollback(operation.id);
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
