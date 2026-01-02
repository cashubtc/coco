/**
 * State machine for melt operations:
 *
 * init ──► prepared ──► executing ──► pending ──► finalized
 *   │         │            │            │            │
 *   │         │            └────────────┴────────────┘ (if PAID)
 *   │         │            │            │
 *   │         │            │            └──► rolling_back ──► rolled_back
 *   │         │            │                      │
 *   └─────────┴────────────┴──────────────────────┴──► rolled_back
 *
 * - init: Operation created, nothing reserved yet
 * - prepared: Proofs reserved, fees calculated, change outputs created, ready to execute
 * - executing: Swap/melt in progress
 * - pending: Melt started, payment inflight (only if PENDING response)
 * - finalized: melt successful, change claimed, operation finalized (can be reached directly from executing if PAID)
 * - failed: melt failed, proofs reclaimed
 * - rolling_back: Rollback in progress (reclaim swap being executed)
 * - rolled_back: Operation cancelled, proofs reclaimed
 */
export type MeltOperationState =
  | 'init'
  | 'prepared'
  | 'executing'
  | 'pending'
  | 'finalized'
  | 'rolling_back'
  | 'rolled_back';

import type { MeltQuoteResponse } from '@cashu/cashu-ts';
import { getSecretsFromSerializedOutputData, type SerializedOutputData } from '../../utils';
import type { MeltMethodData, MeltMethodMeta } from './MeltMethodHandler';

// ============================================================================
// Base and Data Interfaces
// ============================================================================

/**
 * Base fields present in all melt operations
 */
interface MeltOperationBase extends MeltMethodMeta {
  /** Unique identifier for this operation */
  id: string;

  /** The mint URL for this operation */
  mintUrl: string;

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
  /** Whether the operation requires a swap (false = exact match melt) */
  needsSwap: boolean;

  /** The amount requested to melt (before fees) */
  amount: number;

  /** Calculated fee for the swap (0 if exact match) */
  fee_reserve: number;

  /** The ID of the quote used for the melt operation */
  quoteId: string;

  /** The fee for the swap (0 if exact match) */
  swap_fee: number;

  /** Total amount of input proofs selected */
  inputAmount: number;

  /** Secrets of proofs reserved as input for this operation */
  inputProofSecrets: string[];

  /**
   * Serialized OutputData (change) for the melt operation.
   */
  changeOutputData: SerializedOutputData;

  /**
   * Serialized OutputData (swap) for the melt operation.
   */
  swapOutputData?: SerializedOutputData;
}

// ============================================================================
// State-specific Operation Types
// ============================================================================

/**
 * Initial state - operation just created, nothing reserved yet
 */
export interface InitMeltOperation extends MeltOperationBase {
  state: 'init';
}

/**
 * Prepared state - proofs reserved, outputs calculated, ready to execute
 */
export interface PreparedMeltOperation extends MeltOperationBase, PreparedData {
  state: 'prepared';
}

/**
 * Executing state - swap/token creation in progress
 */
export interface ExecutingMeltOperation extends MeltOperationBase, PreparedData {
  state: 'executing';
}

/**
 * Pending state - token returned, awaiting confirmation that proofs are spent
 */
export interface PendingMeltOperation extends MeltOperationBase, PreparedData {
  state: 'pending';
}

/**
 * Finalized state - sent proofs confirmed spent, operation finalized
 */
export interface FinalizedMeltOperation extends MeltOperationBase, PreparedData {
  state: 'finalized';
}

/**
 * Failed state - melt failed, proofs reclaimed
 */
export interface FailedMeltOperation extends MeltOperationBase, PreparedData {
  state: 'failed';
}

/**
 * Rolling back state - rollback in progress, reclaim swap being executed.
 * This is a transient state used to prevent race conditions with ProofStateWatcher.
 * Only used when rolling back from 'pending' state (which requires a reclaim swap).
 */
export interface RollingBackMeltOperation extends MeltOperationBase, PreparedData {
  state: 'rolling_back';
}

/**
 * Rolled back state - operation cancelled, proofs reclaimed
 * Can be rolled back from prepared, executing, or pending states
 */
export interface RolledBackMeltOperation extends MeltOperationBase, PreparedData {
  state: 'rolled_back';
}

// ============================================================================
// Union Type
// ============================================================================

/**
 * Discriminated union of all melt operation states.
 * TypeScript will narrow the type based on the `state` field.
 */
export type MeltOperation =
  | InitMeltOperation
  | PreparedMeltOperation
  | ExecutingMeltOperation
  | PendingMeltOperation
  | FinalizedMeltOperation
  | FailedMeltOperation
  | RollingBackMeltOperation
  | RolledBackMeltOperation;

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Any operation that has been prepared (has PreparedData)
 */
export type PreparedOrLaterOperation =
  | PreparedMeltOperation
  | ExecutingMeltOperation
  | PendingMeltOperation
  | FinalizedMeltOperation
  | FailedMeltOperation
  | RollingBackMeltOperation
  | RolledBackMeltOperation;

/**
 * Terminal states - operation is finished
 * Note: 'rolling_back' is NOT terminal - it's a transient state that needs recovery
 */
export type TerminalMeltOperation =
  | FinalizedMeltOperation
  | RolledBackMeltOperation
  | FailedMeltOperation;

// ============================================================================
// Type Guards
// ============================================================================

export function isInitOperation(op: MeltOperation): op is InitMeltOperation {
  return op.state === 'init';
}

export function isPreparedOperation(op: MeltOperation): op is PreparedMeltOperation {
  return op.state === 'prepared';
}

export function isExecutingOperation(op: MeltOperation): op is ExecutingMeltOperation {
  return op.state === 'executing';
}

export function isPendingOperation(op: MeltOperation): op is PendingMeltOperation {
  return op.state === 'pending';
}

export function isFinalizedOperation(op: MeltOperation): op is FinalizedMeltOperation {
  return op.state === 'finalized';
}

export function isRollingBackOperation(op: MeltOperation): op is RollingBackMeltOperation {
  return op.state === 'rolling_back';
}

export function isRolledBackOperation(op: MeltOperation): op is RolledBackMeltOperation {
  return op.state === 'rolled_back';
}

/**
 * Check if operation has PreparedData (any state after init)
 */
export function hasPreparedData(op: MeltOperation): op is PreparedOrLaterOperation {
  return op.state !== 'init';
}

/**
 * Check if operation is in a terminal state
 */
export function isTerminalOperation(op: MeltOperation): op is TerminalMeltOperation {
  return op.state === 'finalized' || op.state === 'rolled_back';
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new SendOperation in init state
 */
export function createMeltOperation(
  id: string,
  mintUrl: string,
  meta: MeltMethodMeta,
): InitMeltOperation {
  const now = Date.now();
  return {
    ...meta,
    id,
    state: 'init',
    mintUrl,
    createdAt: now,
    updatedAt: now,
  };
}
