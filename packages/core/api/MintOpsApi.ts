import { Amount, type AmountLike } from '@cashu/cashu-ts';
import type {
  MintMethod,
  MintOperation,
  MintOperationService,
  PendingMintCheckResult,
  PendingMintOperation,
} from '@core/operations/mint';
import type { MintQuoteRef, QuoteIdentity } from '../models/QuoteIdentity.ts';

/** Mint methods supported by the default `Manager` wiring. */
export type DefaultSupportedMintMethod = 'bolt11' | 'onchain' | 'bolt12';

export type PrepareMintInput<TSupported extends MintMethod = DefaultSupportedMintMethod> = {
  /** Existing canonical mint quote or structural quote reference. */
  quote: MintQuoteRef<TSupported>;
  /** Amount to mint using the canonical quote's stored unit. */
  amount: AmountLike;
};

export interface MintRecoveryApi {
  /** Runs the startup-style recovery sweep for mint operations. */
  run(): Promise<void>;
  /** Returns true while a recovery sweep is running. */
  inProgress(): boolean;
}

export interface MintDiagnosticsApi {
  /** Returns true while an operation is currently locked by the service. */
  isLocked(operationId: string): boolean;
}

/**
 * Operation-oriented API for quote-backed mint workflows.
 *
 * This API makes the mint lifecycle explicit so callers can move a canonical
 * quote into a durable pending operation, execute it, and inspect its progress.
 */
export class MintOpsApi<TSupported extends MintMethod = DefaultSupportedMintMethod> {
  /** Recovery helpers for mint operations. */
  readonly recovery: MintRecoveryApi = {
    run: async () => this.mintOperationService.recoverPendingOperations(),
    inProgress: () => this.mintOperationService.isRecoveryInProgress(),
  };

  /** Lightweight diagnostics for mint operations. */
  readonly diagnostics: MintDiagnosticsApi = {
    isLocked: (operationId: string) => this.mintOperationService.isOperationLocked(operationId),
  };

  constructor(private readonly mintOperationService: MintOperationService) {}

  /**
   * Prepares a mint operation against an existing canonical quote without executing it.
   */
  async prepare(input: PrepareMintInput<TSupported>): Promise<PendingMintOperation> {
    return this.mintOperationService.prepare(input.quote, Amount.from(input.amount));
  }

  /**
   * Executes a pending mint operation and returns the latest operation state.
   */
  async execute(operationOrId: MintOperation | string): Promise<MintOperation> {
    const operation = await this.resolveOperation(operationOrId);
    if (operation.state !== 'pending') {
      throw new Error(
        `Cannot execute operation in state '${operation.state}'. Expected 'pending'.`,
      );
    }

    return this.mintOperationService.execute(operation.id);
  }

  /** Returns a mint operation by ID, or `null` when it does not exist. */
  async get(operationId: string): Promise<MintOperation | null> {
    return this.mintOperationService.getOperation(operationId);
  }

  /** Lists mint operations for a mint URL and quote ID. */
  async listByQuote(input: QuoteIdentity): Promise<MintOperation[]> {
    return this.mintOperationService.listOperationsByQuote(input.mintUrl, input.quoteId);
  }

  /** Lists mint operations that are pending redemption or remote settlement. */
  async listPending(): Promise<PendingMintOperation[]> {
    return this.mintOperationService.getPendingOperations();
  }

  /** Lists mint operations that are pending or currently executing. */
  async listInFlight(): Promise<MintOperation[]> {
    return this.mintOperationService.getInFlightOperations();
  }

  /**
   * Checks the remote quote state for a pending mint operation.
   * Paid or issued quotes are reconciled immediately.
   */
  async checkPayment(operationId: string): Promise<PendingMintCheckResult> {
    const operation = await this.requireOperation(operationId);
    if (operation.state !== 'pending') {
      throw new Error(`Cannot check payment in state '${operation.state}'. Expected 'pending'.`);
    }

    return this.mintOperationService.checkPendingOperation(operation.id);
  }

  /**
   * Re-checks a mint operation and returns its latest persisted state.
   */
  async refresh(operationId: string): Promise<MintOperation> {
    const operation = await this.requireOperation(operationId);
    if (operation.state === 'pending') {
      await this.mintOperationService.checkPendingOperation(operation.id);
      return this.requireOperation(operationId);
    }

    if (operation.state === 'executing') {
      await this.mintOperationService.recoverExecutingOperation(operation);
      return this.requireOperation(operationId);
    }

    return operation;
  }

  /**
   * Attempts to finalize a mint operation explicitly.
   *
   * Pending operations are executed, executing operations are recovered,
   * and terminal operations are returned as-is.
   */
  async finalize(operationId: string): Promise<MintOperation> {
    return this.mintOperationService.finalize(operationId);
  }

  private async resolveOperation(operationOrId: MintOperation | string): Promise<MintOperation> {
    if (typeof operationOrId === 'string') {
      return this.requireOperation(operationOrId);
    }

    return this.requireOperation(operationOrId.id);
  }

  private async requireOperation(operationId: string): Promise<MintOperation> {
    const operation = await this.mintOperationService.getOperation(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    return operation;
  }
}
