/**
 * State machine for send operations:
 *
 * init ──► prepared ──► executing ──► pending ──► completed
 *   │         │            │            │
 *   └─────────┴────────────┴────────────┴──► rolled_back
 *
 * - init: Operation created, nothing reserved yet
 * - prepared: Proofs reserved, outputs created, ready to execute
 * - executing: Swap/token creation in progress
 * - pending: Token returned to consumer, awaiting confirmation (proofs spent)
 * - completed: Sent proofs confirmed spent, operation finalized
 * - rolled_back: Operation cancelled, proofs reclaimed
 */
export type SendOperationState =
  | 'init'
  | 'prepared'
  | 'executing'
  | 'pending'
  | 'completed'
  | 'rolled_back';

/**
 * Represents a send operation saga.
 *
 * The operation tracks all data needed to:
 * - Resume after a crash
 * - Rollback if the token is not claimed
 * - Audit the operation history
 */
export interface SendOperation {
  /** Unique identifier for this operation */
  id: string;

  /** Current state of the operation */
  state: SendOperationState;

  /** The mint URL for this operation */
  mintUrl: string;

  /** The amount requested to send (before fees) */
  amount: number;

  /** Timestamp when the operation was created */
  createdAt: number;

  /** Timestamp when the operation was last updated */
  updatedAt: number;

  // --- Set during prepare ---

  /** Whether the operation requires a swap (false = exact match send) */
  needsSwap?: boolean;

  /** Calculated fee for the swap (0 if exact match) */
  fee?: number;

  /** Total amount of input proofs selected */
  inputAmount?: number;

  /** Secrets of proofs reserved as input for this operation */
  inputProofSecrets?: string[];

  /** The keyset ID used for creating outputs */
  keysetId?: string;

  /** Counter value at the start of output creation (for deterministic recovery) */
  counterStart?: number;

  /** Calculated keep amount (change) after fees */
  keepAmount?: number;

  /** Calculated send amount (may differ from requested amount if including receiver fees) */
  sendAmount?: number;

  // --- Set during execute ---

  /** Secrets of proofs we keep (change from swap) */
  keepProofSecrets?: string[];

  /** Secrets of proofs in the send token */
  sendProofSecrets?: string[];

  // --- Error tracking ---

  /** Error message if the operation failed */
  error?: string;
}

/**
 * Creates a new SendOperation in init state
 */
export function createSendOperation(
  id: string,
  mintUrl: string,
  amount: number,
): SendOperation {
  const now = Date.now();
  return {
    id,
    state: 'init',
    mintUrl,
    amount,
    createdAt: now,
    updatedAt: now,
  };
}

