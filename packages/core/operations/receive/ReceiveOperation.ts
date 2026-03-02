/**
 * State machine for receive operations:
 *
 * init ──► prepared ──► executing ──► finalized
 *   │         │            │
 *   └─────────┴────────────┴──► rolled_back
 *
 * - init: Operation created, token decoded/validated
 * - prepared: Fees calculated, outputs created, ready to execute
 * - executing: Receive in progress (mint interaction)
 * - finalized: Proofs saved, operation complete
 * - rolled_back: Operation failed or aborted before completion
 */
export type ReceiveOperationState = 'init' | 'prepared' | 'executing' | 'finalized' | 'rolled_back';

import type { Proof } from '@cashu/cashu-ts';
import { getSecretsFromSerializedOutputData, type SerializedOutputData } from '../../utils';

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

  /** The amount received (sum of input proofs) */
  amount: number;

  /** Proofs contained in the received token (prepared for receiving) */
  inputProofs: Proof[];

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
  /** Fees charged for the receive operation */
  fee: number;

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

export function isFinalizedOperation(op: ReceiveOperation): op is FinalizedReceiveOperation {
  return op.state === 'finalized';
}

export function isRolledBackOperation(op: ReceiveOperation): op is RolledBackReceiveOperation {
  return op.state === 'rolled_back';
}

export function hasPreparedData(op: ReceiveOperation): op is PreparedOrLaterOperation {
  return op.state !== 'init';
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
  amount: number,
  inputProofs: Proof[],
): InitReceiveOperation {
  const now = Date.now();
  return {
    id,
    state: 'init',
    mintUrl,
    amount,
    inputProofs,
    createdAt: now,
    updatedAt: now,
  };
}
