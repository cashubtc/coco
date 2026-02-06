/**
 * State machine for send operations:
 *
 * init ──► prepared ──► executing ──► pending ──► finalized
 *   │         │            │            │
 *   │         │            │            └──► rolling_back ──► rolled_back
 *   │         │            │                      │
 *   └─────────┴────────────┴──────────────────────┴──► rolled_back
 *
 * - init: Operation created, nothing reserved yet
 * - prepared: Proofs reserved, outputs created, ready to execute
 * - executing: Swap/token creation in progress
 * - pending: Token returned to consumer, awaiting confirmation (proofs spent)
 * - finalized: Sent proofs confirmed spent, operation finalized
 * - rolling_back: Rollback in progress (reclaim swap being executed)
 * - rolled_back: Operation cancelled, proofs reclaimed
 */
export type SendOperationState =
  | 'init'
  | 'prepared'
  | 'executing'
  | 'pending'
  | 'finalized'
  | 'rolling_back'
  | 'rolled_back';

import { getSecretsFromSerializedOutputData, type SerializedOutputData } from '../../utils';

// ============================================================================
// Base and Data Interfaces
// ============================================================================

/**
 * Base fields present in all send operations
 */
interface SendOperationBase {
  /** Unique identifier for this operation */
  id: string;

  /** The mint URL for this operation */
  mintUrl: string;

  /** The amount requested to send (before fees) */
  amount: number;

  /** The unit for this operation (e.g., 'sat', 'usd') */
  unit: string;

  /** Timestamp when the operation was created */
  createdAt: number;

  /** Timestamp when the operation was last updated */
  updatedAt: number;

  /** Error message if the operation failed */
  error?: string;
}

/**
 * Data set during the prepare phase
 */
interface PreparedData {
  /** Whether the operation requires a swap (false = exact match send) */
  needsSwap: boolean;

  /** Calculated fee for the swap (0 if exact match) */
  fee: number;

  /** Total amount of input proofs selected */
  inputAmount: number;

  /** Secrets of proofs reserved as input for this operation */
  inputProofSecrets: string[];

  /**
   * Serialized OutputData for the swap operation.
   * Only present if needsSwap is true.
   * Contains all information needed for recovery:
   * - Blinded messages (with keyset ID)
   * - Blinding factors
   * - Secrets (for deriving proof secrets)
   */
  outputData?: SerializedOutputData;
}

// ============================================================================
// State-specific Operation Types
// ============================================================================

/**
 * Initial state - operation just created, nothing reserved yet
 */
export interface InitSendOperation extends SendOperationBase {
  state: 'init';
}

/**
 * Prepared state - proofs reserved, outputs calculated, ready to execute
 */
export interface PreparedSendOperation extends SendOperationBase, PreparedData {
  state: 'prepared';
}

/**
 * Executing state - swap/token creation in progress
 */
export interface ExecutingSendOperation extends SendOperationBase, PreparedData {
  state: 'executing';
}

/**
 * Pending state - token returned, awaiting confirmation that proofs are spent
 */
export interface PendingSendOperation extends SendOperationBase, PreparedData {
  state: 'pending';
}

/**
 * Finalized state - sent proofs confirmed spent, operation finalized
 */
export interface FinalizedSendOperation extends SendOperationBase, PreparedData {
  state: 'finalized';
}

/**
 * Rolling back state - rollback in progress, reclaim swap being executed.
 * This is a transient state used to prevent race conditions with ProofStateWatcher.
 * Only used when rolling back from 'pending' state (which requires a reclaim swap).
 */
export interface RollingBackSendOperation extends SendOperationBase, PreparedData {
  state: 'rolling_back';
}

/**
 * Rolled back state - operation cancelled, proofs reclaimed
 * Can be rolled back from prepared, executing, or pending states
 */
export interface RolledBackSendOperation extends SendOperationBase, PreparedData {
  state: 'rolled_back';
}

// ============================================================================
// Union Type
// ============================================================================

/**
 * Discriminated union of all send operation states.
 * TypeScript will narrow the type based on the `state` field.
 */
export type SendOperation =
  | InitSendOperation
  | PreparedSendOperation
  | ExecutingSendOperation
  | PendingSendOperation
  | FinalizedSendOperation
  | RollingBackSendOperation
  | RolledBackSendOperation;

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Any operation that has been prepared (has PreparedData)
 */
export type PreparedOrLaterOperation =
  | PreparedSendOperation
  | ExecutingSendOperation
  | PendingSendOperation
  | FinalizedSendOperation
  | RollingBackSendOperation
  | RolledBackSendOperation;

/**
 * Terminal states - operation is finished
 * Note: 'rolling_back' is NOT terminal - it's a transient state that needs recovery
 */
export type TerminalSendOperation = FinalizedSendOperation | RolledBackSendOperation;

// ============================================================================
// Type Guards
// ============================================================================

export function isInitOperation(op: SendOperation): op is InitSendOperation {
  return op.state === 'init';
}

export function isPreparedOperation(op: SendOperation): op is PreparedSendOperation {
  return op.state === 'prepared';
}

export function isExecutingOperation(op: SendOperation): op is ExecutingSendOperation {
  return op.state === 'executing';
}

export function isPendingOperation(op: SendOperation): op is PendingSendOperation {
  return op.state === 'pending';
}

export function isFinalizedOperation(op: SendOperation): op is FinalizedSendOperation {
  return op.state === 'finalized';
}

export function isRollingBackOperation(op: SendOperation): op is RollingBackSendOperation {
  return op.state === 'rolling_back';
}

export function isRolledBackOperation(op: SendOperation): op is RolledBackSendOperation {
  return op.state === 'rolled_back';
}

/**
 * Check if operation has PreparedData (any state after init)
 */
export function hasPreparedData(op: SendOperation): op is PreparedOrLaterOperation {
  return op.state !== 'init';
}

/**
 * Check if operation is in a terminal state
 */
export function isTerminalOperation(op: SendOperation): op is TerminalSendOperation {
  return op.state === 'finalized' || op.state === 'rolled_back';
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the secrets of proofs that will be sent (for finalization tracking).
 * - If needsSwap: secrets come from outputData.send
 * - If !needsSwap: secrets are the inputProofSecrets (exact match)
 */
export function getSendProofSecrets(op: PreparedOrLaterOperation): string[] {
  if (!op.needsSwap) {
    return op.inputProofSecrets;
  }
  if (!op.outputData) {
    return [];
  }
  const { sendSecrets } = getSecretsFromSerializedOutputData(op.outputData);
  return sendSecrets;
}

/**
 * Get the secrets of proofs we keep (change from swap).
 * - If needsSwap: secrets come from outputData.keep
 * - If !needsSwap: empty (no change proofs)
 */
export function getKeepProofSecrets(op: PreparedOrLaterOperation): string[] {
  if (!op.needsSwap) {
    return [];
  }
  if (!op.outputData) {
    return [];
  }
  const { keepSecrets } = getSecretsFromSerializedOutputData(op.outputData);
  return keepSecrets;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new SendOperation in init state
 */
export function createSendOperation(
  id: string,
  mintUrl: string,
  amount: number,
  unit: string = 'sat',
): InitSendOperation {
  const now = Date.now();
  return {
    id,
    state: 'init',
    mintUrl,
    amount,
    unit,
    createdAt: now,
    updatedAt: now,
  };
}
