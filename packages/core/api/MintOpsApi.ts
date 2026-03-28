import type {
  MintMethod,
  MintMethodData,
  MintMethodQuoteSnapshot,
  MintOperation,
  MintOperationService,
  PendingMintCheckResult,
  PendingMintOperation,
  TerminalMintOperation,
} from '@core/operations/mint';

/** Mint methods supported by the default `Manager` wiring. */
export type DefaultSupportedMintMethod = 'bolt11';

type PrepareMintInputCommon = {
  /** Mint that will execute the quote-backed mint operation. */
  mintUrl: string;
  /** Amount to request from the mint. */
  amount: number;
  /** Unit to request from the mint. Only `sat` is currently supported. */
  unit?: 'sat';
};

type ImportMintQuoteInputCommon = {
  /** Mint that issued the existing quote. */
  mintUrl: string;
};

type MethodDataInput<M extends MintMethod> = MintMethodData<M> extends Record<string, never>
  ? {
      /** Method-specific payload required for the selected mint method. */
      methodData?: MintMethodData<M>;
    }
  : {
      /** Method-specific payload required for the selected mint method. */
      methodData: MintMethodData<M>;
    };

export type PrepareMintInput<TSupported extends MintMethod = DefaultSupportedMintMethod> = {
  [M in TSupported]: PrepareMintInputCommon & {
    /** Mint method to prepare, for example `bolt11`. */
    method: M;
  } & MethodDataInput<M>;
}[TSupported];

export type ImportMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintMethod> = {
  [M in TSupported]: ImportMintQuoteInputCommon & {
    /** Existing quote snapshot to track as an operation. */
    quote: MintMethodQuoteSnapshot<M>;
    /** Mint method to prepare, for example `bolt11`. */
    method: M;
  } & MethodDataInput<M>;
}[TSupported];

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
 * This API makes the mint lifecycle explicit so callers can prepare a quote,
 * move it into a durable pending state, execute it, and inspect its progress.
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

  private assertSupportedUnit(unit: string): void {
    if (unit !== 'sat') {
      throw new Error(`Unsupported mint unit '${unit}'. Only 'sat' is currently supported.`);
    }
  }

  /**
   * Creates a new remote quote, then persists a prepared mint operation without executing it.
   */
  async prepare(input: PrepareMintInput<TSupported>): Promise<PendingMintOperation> {
    const unit = input.unit ?? 'sat';
    this.assertSupportedUnit(unit);
    const methodData = ('methodData' in input ? input.methodData : undefined) ?? {};

    return this.mintOperationService.prepareNewQuote(
      input.mintUrl,
      input.amount,
      unit,
      input.method,
      methodData,
    );
  }

  /**
   * Imports an existing quote snapshot into a prepared mint operation without executing it.
   */
  async importQuote(input: ImportMintQuoteInput<TSupported>): Promise<PendingMintOperation> {
    this.assertSupportedUnit(input.quote.unit);
    const methodData = ('methodData' in input ? input.methodData : undefined) ?? {};

    return this.mintOperationService.importQuote(
      input.mintUrl,
      input.quote,
      input.method,
      methodData,
    );
  }

  /**
   * Executes a pending mint operation and returns its terminal state.
   */
  async execute(operationOrId: MintOperation | string): Promise<TerminalMintOperation> {
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

  /** Returns a mint operation by mint URL and quote ID, or `null` if not found. */
  async getByQuote(mintUrl: string, quoteId: string): Promise<MintOperation | null> {
    return this.mintOperationService.getOperationByQuote(mintUrl, quoteId);
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
  async finalize(operationId: string): Promise<TerminalMintOperation> {
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
