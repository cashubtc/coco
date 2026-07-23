import Dexie, { type Transaction as DexieTransaction } from 'dexie';
import type { SerializedBlindedSignature } from '@cashu/cashu-ts';

export interface IdbDbOptions {
  name?: string;
}

/**
 * Wrapper around Dexie providing transaction management for IndexedDB.
 *
 * Transaction behavior:
 * - Nested transactions within the same Dexie transaction context are reused
 * - Concurrent transactions are queued and executed serially
 * - Dexie handles automatic commit/rollback based on promise resolution/rejection
 */
export class IdbDb extends Dexie {
  /** Promise chain used to serialize concurrent transactions */
  private transactionQueue: Promise<void> = Promise.resolve();
  /** Currently active Dexie transaction (null if no transaction) */
  private activeTransaction: DexieTransaction | null = null;

  // tables are defined in schema.ts via version stores
  constructor(options: IdbDbOptions = {}) {
    super(options.name ?? 'coco_cashu');
  }

  /**
   * Execute a function within a database transaction.
   *
   * Transaction Semantics:
   *
   * 1. NESTED TRANSACTIONS (same Dexie context):
   *    When runTransaction() is called from within an active transaction,
   *    Dexie.currentTransaction will be set. The inner call reuses this transaction.
   *    No new transaction is created.
   *
   * 2. CONCURRENT TRANSACTIONS (different contexts):
   *    When runTransaction() is called while another transaction is active but from
   *    a different context, the new transaction waits in a queue. This prevents
   *    conflicts and ensures serialization of operations.
   *
   * 3. ERROR HANDLING:
   *    Dexie automatically rolls back the transaction if the promise is rejected.
   *    The transaction queue is properly released even on error, allowing subsequent
   *    transactions to proceed.
   *
   * @param mode - Transaction mode: 'r' (readonly) or 'rw' (readwrite)
   * @param stores - Array of store names to include in the transaction
   * @param fn - Function to execute within the transaction, receives a Dexie transaction
   * @returns Promise that resolves with the return value of fn
   * @throws Re-throws any error from fn after Dexie rolls back the transaction
   */
  async runTransaction<T>(
    mode: 'r' | 'rw',
    stores: string[],
    fn: (txDb: DexieTransaction) => Promise<T>,
  ): Promise<T> {
    // NESTED TRANSACTION DETECTION:
    // Check if we're already inside a Dexie transaction context
    const currentTx = Dexie.currentTransaction as DexieTransaction | undefined;
    if (currentTx && currentTx === this.activeTransaction && currentTx.active) {
      // We're nested and transaction is still active - safe to reuse
      return fn(currentTx);
    }

    // TRANSACTION QUEUE SETUP:
    // Save reference to the previous transaction's completion promise
    const previousTransaction = this.transactionQueue;
    let resolver!: () => void;

    // Create a new promise that will be resolved when THIS transaction completes
    this.transactionQueue = new Promise<void>((resolve) => {
      resolver = resolve;
    });

    try {
      // SERIALIZATION: Wait for the previous transaction to complete
      await previousTransaction;

      // EXECUTE TRANSACTION:
      // Use Dexie's built-in transaction management (automatic commit/rollback)
      return await this.transaction(mode, stores, async (tx) => {
        // Track the active transaction for nested call detection
        const previousActive = this.activeTransaction;
        this.activeTransaction = tx;
        try {
          return await fn(tx);
        } finally {
          // Restore previous transaction (for deeply nested cases)
          this.activeTransaction = previousActive;
        }
      });
    } finally {
      // CLEANUP: Release the queue
      // This allows the next queued transaction to proceed
      resolver(); // Critical: This unblocks the next transaction in the queue
    }
  }

  get currentTransaction(): DexieTransaction | null {
    return Dexie.currentTransaction ?? this.activeTransaction;
  }
}

export function getUnixTimeSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Table types, declared to help repositories with typings
export interface MintRow {
  mintUrl: string;
  name: string;
  mintInfo: string; // JSON string
  trusted?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface KeysetRow {
  mintUrl: string;
  id: string;
  unit?: string;
  keypairs: string; // JSON string
  active: number; // 0/1
  feePpk: number;
  updatedAt: number;
}

export interface CounterRow {
  mintUrl: string;
  keysetId: string;
  counter: number;
}

export interface ProofRow {
  mintUrl: string;
  id: string;
  unit?: string | null;
  amount: string | number;
  secret: string;
  C: string;
  dleqJson?: string | null;
  witness?: string | null;
  state: 'inflight' | 'ready' | 'spent';
  createdAt: number;
  usedByOperationId?: string | null;
  createdByOperationId?: string | null;
}

export interface MintQuoteRow {
  mintUrl: string;
  method: string;
  quoteId: string;
  state: 'UNPAID' | 'PAID' | 'ISSUED' | null;
  request: string;
  amount: string | number | null;
  unit: string;
  expiry: number | null;
  pubkey?: string | null;
  quoteDataJson?: string | null;
  lastObservedRemoteState?: 'UNPAID' | 'PAID' | 'ISSUED' | null;
  lastObservedRemoteStateAt?: number | null;
  reusable: number;
  createdAt: number;
  updatedAt: number;
}

export interface MeltQuoteRow {
  mintUrl: string;
  method: string;
  quoteId: string;
  quote: string;
  state: 'UNPAID' | 'PENDING' | 'PAID';
  request: string;
  amount: string | number;
  unit: string;
  expiry: number;
  fee_reserve?: string | number | null;
  fee_options?: { fee_index: number; fee_reserve: string | number; estimated_blocks: number }[];
  outpoint?: string | null;
  payment_preimage?: string | null;
  change?: SerializedBlindedSignature[];
  lastObservedRemoteState?: 'UNPAID' | 'PENDING' | 'PAID' | null;
  lastObservedRemoteStateAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SendOperationRow {
  id: string;
  mintUrl: string;
  amount: string | number;
  unit?: string | null;
  state:
    | 'init'
    | 'prepared'
    | 'executing'
    | 'pending'
    | 'finalized'
    | 'rolling_back'
    | 'rolled_back';
  createdAt: number;
  updatedAt: number;
  error?: string | null;
  method: string;
  methodDataJson: string;
  needsSwap?: number | null;
  fee?: string | number | null;
  inputAmount?: string | number | null;
  inputProofSecretsJson?: string | null;
  outputDataJson?: string | null;
  tokenJson?: string | null;
}

export interface ReceiveOperationRow {
  id: string;
  mintUrl: string;
  unit?: string | null;
  amount: string | number;
  state: 'init' | 'prepared' | 'executing' | 'deferred' | 'finalized' | 'rolled_back';
  createdAt: number;
  updatedAt: number;
  error?: string | null;
  fee?: string | number | null;
  inputProofsJson?: string | null;
  outputDataJson?: string | null;
  sourceJson?: string | null;
  deferredReason?: 'dust' | 'mint-unreachable' | null;
  batchId?: string | null;
}

export interface PaymentRequestReceiveOperationRow {
  id: string;
  requestId?: string | null;
  encodedRequest: string;
  state: 'active' | 'completed' | 'cancelled';
  transport: 'inband' | 'nostr' | 'post';
  amount: string | number;
  unit: string;
  mintsJson: string;
  singleUse: number;
  description?: string | null;
  createdAt: number;
  updatedAt: number;
  error?: string | null;
  completedAt?: number | null;
}

export interface PaymentRequestReceiveAttemptRow {
  id: string;
  requestOperationId: string;
  requestId?: string | null;
  transport: 'inband' | 'nostr' | 'post';
  transportMessageId?: string | null;
  payloadHash: string;
  senderPubkey?: string | null;
  memo?: string | null;
  mintUrl: string;
  unit: string;
  grossAmount: string | number;
  fee?: string | number | null;
  netAmount?: string | number | null;
  receiveOperationId?: string | null;
  state: 'received' | 'validating' | 'receiving' | 'finalized' | 'rejected';
  error?: string | null;
  payloadJson?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MeltOperationRow {
  id: string;
  mintUrl: string;
  state:
    | 'init'
    | 'prepared'
    | 'executing'
    | 'pending'
    | 'finalized'
    | 'rolling_back'
    | 'rolled_back';
  createdAt: number;
  updatedAt: number;
  error?: string | null;
  method: string;
  methodDataJson: string;
  quoteId?: string | null;
  unit?: string | null;
  amount?: string | number | null;
  fee_reserve?: string | number | null;
  swap_fee?: string | number | null;
  needsSwap?: number | null;
  inputAmount?: string | number | null;
  inputProofSecretsJson?: string | null;
  changeOutputDataJson?: string | null;
  swapOutputDataJson?: string | null;
  changeAmount?: string | number | null;
  effectiveFee?: string | number | null;
  finalizedDataJson?: string | null;
}

export interface AuthSessionRow {
  mintUrl: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string | null;
  batPoolJson: string | null;
}

export interface MintOperationRow {
  id: string;
  mintUrl: string;
  quoteId?: string | null;
  state: 'init' | 'pending' | 'executing' | 'finalized' | 'failed';
  createdAt: number;
  updatedAt: number;
  error?: string | null;
  method: string;
  methodDataJson: string;
  amount?: string | number | null;
  unit?: string | null;
  request?: string | null;
  expiry?: number | null;
  pubkey?: string | null;
  lastObservedRemoteState?: string | null;
  lastObservedRemoteStateAt?: number | null;
  terminalFailureJson?: string | null;
  outputDataJson?: string | null;
}
