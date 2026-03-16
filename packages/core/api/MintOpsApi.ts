import type { MintQuoteBolt11Response } from '@cashu/cashu-ts';

export interface PrepareMintInput {
  /** Mint that will issue the quote-backed mint operation. */
  mintUrl: string;
  /** Amount to mint in sats. */
  amount: number;
}

export interface AwaitMintPaymentInput {
  /** Managed operation ID to wait on. */
  operationId?: string;
  /** Mint URL for quote lookup when no operation ID is available. */
  mintUrl?: string;
  /** Quote ID for quote lookup when no operation ID is available. */
  quoteId?: string;
}

export interface ImportMintQuotesInput {
  /** Mint that created the external quotes. */
  mintUrl: string;
  /** Quote payloads to import into managed operations. */
  quotes: MintQuoteBolt11Response[];
}

export interface RequeuePaidMintQuotesInput {
  /** Optional mint filter for paid quotes to requeue. */
  mintUrl?: string;
}

export type MintOperationState = 'prepared' | 'pending' | 'finalized' | 'failed' | 'rolled_back';

interface MintOperationBase {
  /** Unique identifier for this operation. */
  id: string;
  /** Mint URL associated with the quote-backed operation. */
  mintUrl: string;
  /** Timestamp when the operation was created. */
  createdAt: number;
  /** Timestamp when the operation was last updated. */
  updatedAt: number;
  /** Error message if the operation failed. */
  error?: string;
  /** Full mint quote payload backing the operation. */
  quote: MintQuoteBolt11Response;
}

export interface PreparedMintOperation extends MintOperationBase {
  state: 'prepared';
}

export interface PendingMintOperation extends MintOperationBase {
  state: 'pending';
}

export interface FinalizedMintOperation extends MintOperationBase {
  state: 'finalized';
}

export interface FailedMintOperation extends MintOperationBase {
  state: 'failed';
}

export interface RolledBackMintOperation extends MintOperationBase {
  state: 'rolled_back';
}

export type MintOperation =
  | PreparedMintOperation
  | PendingMintOperation
  | FinalizedMintOperation
  | FailedMintOperation
  | RolledBackMintOperation;

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
 * Operation-oriented API shell for quote-backed mint workflows.
 */
export class MintOpsApi {
  readonly recovery: MintRecoveryApi = {
    run: async () => {
      throw this.notImplemented();
    },
    inProgress: () => false,
  };

  readonly diagnostics: MintDiagnosticsApi = {
    isLocked: () => false,
  };

  async prepare(_input: PrepareMintInput): Promise<PreparedMintOperation> {
    throw this.notImplemented();
  }

  async execute(
    _operationOrId: MintOperation | string,
  ): Promise<PendingMintOperation | FinalizedMintOperation> {
    throw this.notImplemented();
  }

  async get(_operationId: string): Promise<MintOperation | null> {
    throw this.notImplemented();
  }

  async getByQuote(_mintUrl: string, _quoteId: string): Promise<MintOperation | null> {
    throw this.notImplemented();
  }

  async listPrepared(): Promise<PreparedMintOperation[]> {
    throw this.notImplemented();
  }

  async listInFlight(): Promise<MintOperation[]> {
    throw this.notImplemented();
  }

  async refresh(_operationId: string): Promise<MintOperation> {
    throw this.notImplemented();
  }

  async cancel(_operationId: string, _reason?: string): Promise<void> {
    throw this.notImplemented();
  }

  async awaitPayment(_input: AwaitMintPaymentInput): Promise<MintOperation> {
    throw this.notImplemented();
  }

  async importQuotes(
    _input: ImportMintQuotesInput,
  ): Promise<{ added: string[]; skipped: string[] }> {
    throw this.notImplemented();
  }

  async requeuePaid(
    _input?: RequeuePaidMintQuotesInput,
  ): Promise<{ requeued: string[] }> {
    throw this.notImplemented();
  }

  private notImplemented(): Error {
    return new Error('Mint operation workflow is not available.');
  }
}
