import type {
  FinalizedMeltOperation,
  MeltOperation,
  PendingMeltOperation,
  PreparedMeltOperation,
} from '@core/operations/melt';
import type { MeltMethod, MeltMethodData, MeltOperationService } from '@core/operations/melt';

export type PrepareMeltInput = {
  [M in MeltMethod]: {
    mintUrl: string;
    method: M;
    methodData: MeltMethodData<M>;
  };
}[MeltMethod];

export interface MeltRecoveryApi {
  run(): Promise<void>;
  inProgress(): boolean;
}

export interface MeltDiagnosticsApi {
  isLocked(operationId: string): boolean;
}

export class MeltOpsApi {
  readonly recovery: MeltRecoveryApi = {
    run: async () => this.meltOperationService.recoverPendingOperations(),
    inProgress: () => this.meltOperationService.isRecoveryInProgress(),
  };

  readonly diagnostics: MeltDiagnosticsApi = {
    isLocked: (operationId: string) => this.meltOperationService.isOperationLocked(operationId),
  };

  constructor(private readonly meltOperationService: MeltOperationService) {}

  async prepare(input: PrepareMeltInput): Promise<PreparedMeltOperation> {
    const initOperation = await this.meltOperationService.init(
      input.mintUrl,
      input.method,
      input.methodData,
    );
    return this.meltOperationService.prepare(initOperation.id);
  }

  async execute(
    operationOrId: MeltOperation | string,
  ): Promise<PendingMeltOperation | FinalizedMeltOperation> {
    const operation = await this.resolveOperation(operationOrId);
    if (operation.state !== 'prepared') {
      throw new Error(
        `Cannot execute operation in state '${operation.state}'. Expected 'prepared'.`,
      );
    }

    return this.meltOperationService.execute(operation.id);
  }

  async get(operationId: string): Promise<MeltOperation | null> {
    return this.meltOperationService.getOperation(operationId);
  }

  async getByQuote(mintUrl: string, quoteId: string): Promise<MeltOperation | null> {
    return this.meltOperationService.getOperationByQuote(mintUrl, quoteId);
  }

  async listPrepared(): Promise<PreparedMeltOperation[]> {
    return this.meltOperationService.getPreparedOperations();
  }

  async listInFlight(): Promise<MeltOperation[]> {
    return this.meltOperationService.getPendingOperations();
  }

  /**
   * @deprecated Use `listPrepared()` or `listInFlight()` instead.
   * This alias will be removed in a future release.
   */
  async listActive(): Promise<MeltOperation[]> {
    const [prepared, inFlight] = await Promise.all([this.listPrepared(), this.listInFlight()]);
    return [...prepared, ...inFlight];
  }

  async refresh(operationId: string): Promise<MeltOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state === 'pending') {
      await this.meltOperationService.checkPendingOperation(operation.id);
      return this.requireOperation(operationId);
    }

    return operation;
  }

  async cancel(operationId: string, reason?: string): Promise<void> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'prepared') {
      throw new Error(
        `Cannot cancel operation in state '${operation.state}'. Expected 'prepared'.`,
      );
    }

    await this.meltOperationService.rollback(operation.id, reason);
  }

  async reclaim(operationId: string, reason?: string): Promise<void> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'pending') {
      throw new Error(
        `Cannot reclaim operation in state '${operation.state}'. Expected 'pending'.`,
      );
    }

    await this.meltOperationService.rollback(operation.id, reason);
  }

  async finalize(operationId: string): Promise<void> {
    await this.meltOperationService.finalize(operationId);
  }

  private async resolveOperation(operationOrId: MeltOperation | string): Promise<MeltOperation> {
    if (typeof operationOrId === 'string') {
      return this.requireOperation(operationOrId);
    }

    return this.requireOperation(operationOrId.id);
  }

  private async requireOperation(operationId: string): Promise<MeltOperation> {
    const operation = await this.meltOperationService.getOperation(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    return operation;
  }
}
