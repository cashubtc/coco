/**
 * State machine for receive operations:
 *
 * init ──► prepared ──► executing ──► finalized
 *   │         │            │
 *   │         │            ├──► deferred (batch member returned to queue)
 *   │         │            │
 *   └─────────┴────────────┴──► rolled_back
 *   │
 *   └──► deferred ──► executing (batch redemption)
 *
 * - init: Operation created, token decoded/validated
 * - prepared: Fees calculated, outputs created, ready to execute
 * - executing: Receive in progress (mint interaction)
 * - deferred: Redemption postponed (dust, missing p2pk key, or unreachable mint)
 *   until it can be settled fee-efficiently or its prerequisites exist
 * - finalized: Proofs saved, operation complete
 * - rolled_back: Operation failed or aborted before completion
 */
export type ReceiveOperationState =
  | 'init'
  | 'prepared'
  | 'executing'
  | 'deferred'
  | 'finalized'
  | 'rolled_back';

/**
 * Why a receive operation was deferred:
 * - dust: input value does not cover the swap fee on its own
 * - p2pk-unsigned: the p2pk unlock key is not in the key ring; inputProofs are stored unsigned
 * - mint-unreachable: mint or keyset data could not be fetched (e.g. offline)
 */
export type DeferredReceiveReason = 'dust' | 'p2pk-unsigned' | 'mint-unreachable';

import type { Amount, Proof } from '@cashu/cashu-ts';
import { getSecretsFromSerializedOutputData, type SerializedOutputData } from '../../utils';
import { normalizeUnitAmount, type UnitAmount } from '../../amounts.ts';

export type ReceiveOperationSource =
  | { type: 'manual-token' }
  | {
      type: 'payment-request';
      requestOperationId: string;
      requestId?: string;
      attemptId: string;
      transport: 'inband' | 'nostr' | 'post';
      transportMessageId?: string;
      senderPubkey?: string;
      memo?: string;
    };

// ============================================================================
// Base and Data Interfaces
// ============================================================================

/**
 * Base fields present in all receive operations
 */
interface ReceiveOperationBase {
  /** Unique identifier for this operation */
  id: string;

  /** The mint URL for this operation */
  mintUrl: string;

  /** Unit declared by the received token */
  unit: string;

  /** The amount received (sum of input proofs) */
  amount: Amount;

  /** Proofs contained in the received token (prepared for receiving) */
  inputProofs: Proof[];

  /** Timestamp when the operation was created */
  createdAt: number;

  /** Timestamp when the operation was last updated */
  updatedAt: number;

  /** Error message if the operation failed */
  error?: string;

  /** Optional origin metadata for receives created by higher-level sagas. */
  source?: ReceiveOperationSource;

  /**
   * Groups operations redeemed together in a single batched swap.
   * Only set once a deferred operation enters batch redemption; batch members
   * must never be re-executed solo because their fee was apportioned batch-wide.
   */
  batchId?: string;
}

/**
 * Data set during the prepare phase
 */
interface PreparedData {
  /** Fees charged for the receive operation */
  fee: Amount;

  /** Serialized OutputData for deterministic receive outputs */
  outputData: SerializedOutputData;
}

// ============================================================================
// State-specific Operation Types
// ============================================================================

/**
 * Initial state - operation just created, token decoded
 */
export interface InitReceiveOperation extends ReceiveOperationBase {
  state: 'init';
}

/**
 * Prepared state - outputs created, ready to execute
 */
export interface PreparedReceiveOperation extends ReceiveOperationBase, PreparedData {
  state: 'prepared';
}

/**
 * Executing state - receive in progress
 */
export interface ExecutingReceiveOperation extends ReceiveOperationBase, PreparedData {
  state: 'executing';
}

/**
 * Deferred state - redemption postponed until it can be settled fee-efficiently
 * or its prerequisites exist. Carries no PreparedData; fees and outputs are
 * recomputed at redemption time.
 */
export interface DeferredReceiveOperation extends ReceiveOperationBase {
  state: 'deferred';

  /** Why redemption was postponed */
  deferredReason: DeferredReceiveReason;
}

/**
 * Finalized state - proofs saved, operation complete
 */
export interface FinalizedReceiveOperation extends ReceiveOperationBase, PreparedData {
  state: 'finalized';
}

/**
 * Rolled back state - operation failed or aborted
 */
export interface RolledBackReceiveOperation extends ReceiveOperationBase, PreparedData {
  state: 'rolled_back';
}

// ============================================================================
// Union Type
// ============================================================================

/**
 * Discriminated union of all receive operation states.
 */
export type ReceiveOperation =
  | InitReceiveOperation
  | PreparedReceiveOperation
  | ExecutingReceiveOperation
  | DeferredReceiveOperation
  | FinalizedReceiveOperation
  | RolledBackReceiveOperation;

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Any operation that has been prepared (has PreparedData)
 */
export type PreparedOrLaterOperation =
  | PreparedReceiveOperation
  | ExecutingReceiveOperation
  | FinalizedReceiveOperation
  | RolledBackReceiveOperation;

/**
 * Terminal states - operation is finished
 */
export type TerminalReceiveOperation = FinalizedReceiveOperation | RolledBackReceiveOperation;

// ============================================================================
// Type Guards
// ============================================================================

export function isInitOperation(op: ReceiveOperation): op is InitReceiveOperation {
  return op.state === 'init';
}

export function isPreparedOperation(op: ReceiveOperation): op is PreparedReceiveOperation {
  return op.state === 'prepared';
}

export function isExecutingOperation(op: ReceiveOperation): op is ExecutingReceiveOperation {
  return op.state === 'executing';
}

export function isDeferredOperation(op: ReceiveOperation): op is DeferredReceiveOperation {
  return op.state === 'deferred';
}

export function isFinalizedOperation(op: ReceiveOperation): op is FinalizedReceiveOperation {
  return op.state === 'finalized';
}

export function isRolledBackOperation(op: ReceiveOperation): op is RolledBackReceiveOperation {
  return op.state === 'rolled_back';
}

export function hasPreparedData(op: ReceiveOperation): op is PreparedOrLaterOperation {
  return op.state !== 'init' && op.state !== 'deferred';
}

export function isTerminalOperation(op: ReceiveOperation): op is TerminalReceiveOperation {
  return op.state === 'finalized' || op.state === 'rolled_back';
}

// ============================================================================
// Helpers
// ============================================================================

export function getOutputProofSecrets(op: PreparedOrLaterOperation): string[] {
  const { keepSecrets, sendSecrets } = getSecretsFromSerializedOutputData(op.outputData);
  return [...keepSecrets, ...sendSecrets];
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new ReceiveOperation in init state
 */
export function createReceiveOperation(
  id: string,
  mintUrl: string,
  intent: UnitAmount,
  inputProofs: Proof[],
  source?: ReceiveOperationSource,
): InitReceiveOperation {
  const now = Date.now();
  const amount = normalizeUnitAmount(intent);
  return {
    id,
    state: 'init',
    mintUrl,
    unit: amount.unit,
    amount: amount.amount,
    inputProofs,
    source,
    createdAt: now,
    updatedAt: now,
  };
}
