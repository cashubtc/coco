import type {
  FinalizedMeltOperation,
  MeltOperation,
  PendingMeltOperation,
  PreparedMeltOperation,
} from '@core/operations/melt';
import type { MeltMethod, MeltOperationService } from '@core/operations/melt';
import type { MeltQuoteRef, QuoteIdentity } from '../models/QuoteIdentity.ts';

/** Melt methods supported by the default `Manager` wiring. */
export type DefaultSupportedMeltMethod = 'bolt11' | 'bolt12' | 'onchain';

export type PrepareMeltInput<TSupported extends MeltMethod = DefaultSupportedMeltMethod> = {
  [M in TSupported]: {
    /** Existing canonical melt quote or structural quote reference. */
    quote: MeltQuoteRef<M>;
  } & (M extends 'onchain' ? { feeIndex: number } : { feeIndex?: number });
}[TSupported];

export interface MeltRecoveryApi {
  /** Runs the startup-style recovery sweep for melt operations. */
  run(): Promise<void>;
  /** Returns true while a recovery sweep is running. */
  inProgress(): boolean;
}

export interface MeltDiagnosticsApi {
  /** Returns true while an operation is currently locked by the service. */
  isLocked(operationId: string): boolean;
}

/**
 * Operation-oriented API for melt workflows.
 *
 * This API makes the melt lifecycle explicit so callers can prepare a payment,
 * execute it, inspect or refresh its state, and recover or roll it back when
 * allowed by the underlying method.
 */
export class MeltOpsApi<TSupported extends MeltMethod = DefaultSupportedMeltMethod> {
  /** Recovery helpers for melt operations. */
  readonly recovery: MeltRecoveryApi = {
    run: async () => this.meltOperationService.recoverPendingOperations(),
    inProgress: () => this.meltOperationService.isRecoveryInProgress(),
  };

  /** Lightweight diagnostics for melt operations. */
  readonly diagnostics: MeltDiagnosticsApi = {
    isLocked: (operationId: string) => this.meltOperationService.isOperationLocked(operationId),
  };

  constructor(private readonly meltOperationService: MeltOperationService) {}

  /**
   * Prepares a melt operation against an existing canonical quote without executing it.
   *
   * Use this to inspect the generated operation and any quote-related data
   * before committing to the external payment.
   */
  async prepare(input: PrepareMeltInput<TSupported>): Promise<PreparedMeltOperation> {
    return this.meltOperationService.prepareExistingQuote(input.quote, {
      feeIndex: input.feeIndex,
    });
  }

  /**
   * Executes a prepared melt operation.
   *
   * Accepts either a prepared operation object or its ID. The latest operation
   * state is always reloaded before execution.
   */
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

  /** Returns a melt operation by ID, or `null` when it does not exist. */
  async get(operationId: string): Promise<MeltOperation | null> {
    return this.meltOperationService.getOperation(operationId);
  }

  /** Returns the tracked melt operation for a canonical quote identity, or `null`. */
  async getByQuote(input: QuoteIdentity): Promise<MeltOperation | null> {
    return this.meltOperationService.getOperationByQuoteIdentity(input);
  }

  /** Lists melt operations for a mint URL and quote ID. */
  async listByQuote(input: QuoteIdentity): Promise<MeltOperation[]> {
    return this.meltOperationService.listOperationsByQuote(input.mintUrl, input.quoteId);
  }

  /** Lists melt operations that are prepared and ready to execute or cancel. */
  async listPrepared(): Promise<PreparedMeltOperation[]> {
    return this.meltOperationService.getPreparedOperations();
  }

  /** Lists melt operations that are currently in flight. */
  async listInFlight(): Promise<MeltOperation[]> {
    return this.meltOperationService.getPendingOperations();
  }

  /**
   * Re-checks a melt operation and returns its latest persisted state.
   *
   * Pending operations are actively checked with the service before the updated
   * operation is returned. Executing operations are recovered before returning
   * the updated state.
   */
  async refresh(operationId: string): Promise<MeltOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state === 'pending') {
      await this.meltOperationService.checkPendingOperation(operation.id);
      return this.requireOperation(operationId);
    }

    if (operation.state === 'executing') {
      await this.meltOperationService.recoverExecutingOperation(operation);
      return this.requireOperation(operationId);
    }

    return operation;
  }

  /**
   * Cancels a prepared melt operation before payment has entered the pending
   * phase.
   */
  async cancel(operationId: string, reason?: string): Promise<void> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'prepared') {
      throw new Error(
        `Cannot cancel operation in state '${operation.state}'. Expected 'prepared'.`,
      );
    }

    await this.meltOperationService.rollback(operation.id, reason);
  }

  /**
   * Attempts to reclaim a pending melt operation.
   *
   * This is intended for in-flight melts whose handler determines that rollback
   * is still safe.
   */
  async reclaim(operationId: string, reason?: string): Promise<void> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'pending') {
      throw new Error(
        `Cannot reclaim operation in state '${operation.state}'. Expected 'pending'.`,
      );
    }

    await this.meltOperationService.rollback(operation.id, reason);
  }

  /**
   * Finalizes a pending melt operation explicitly.
   *
   * Most callers should prefer `refresh()` unless they already know the melt is
   * ready to finalize.
   */
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
