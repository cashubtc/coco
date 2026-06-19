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
  | 'failed'
  | 'finalized'
  | 'rolling_back'
  | 'rolled_back';

import type { Amount } from '@cashu/cashu-ts';
import { getSecretsFromSerializedOutputData, type SerializedOutputData } from '../../utils';
import type {
  BuiltInMeltMethod,
  MeltMethod,
  MeltMethodData,
  MeltMethodMeta,
} from './MeltMethodHandler';
import { DEFAULT_UNIT, normalizeUnit } from '../../amounts.ts';

// ============================================================================
// Base and Data Interfaces
// ============================================================================

/**
 * Base fields present in all melt operations
 */
interface MeltOperationBase<M extends MeltMethod = BuiltInMeltMethod> extends MeltMethodMeta<M> {
  /** Unique identifier for this operation */
  id: string;

  /** The mint URL for this operation */
  mintUrl: string;

  /** Unit for all amounts, proofs, quotes, outputs, and change in this operation. */
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
  /** Whether the operation requires a swap (false = exact match melt) */
  needsSwap: boolean;

  /** The amount requested to melt (before fees) */
  amount: Amount;

  /** Calculated fee for the swap (0 if exact match) */
  fee_reserve: Amount;

  /** The ID of the quote used for the melt operation */
  quoteId: string;

  /** The fee for the swap (0 if exact match) */
  swap_fee: Amount;

  /** Total amount of input proofs selected */
  inputAmount: Amount;

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

/**
 * Method-specific data that may be available once a melt has settled.
 */
type BuiltInMeltMethodFinalizedDataMap = {
  bolt11: {
    preimage?: string;
    outpoint?: never;
  };
  bolt12: {
    preimage?: string;
    outpoint?: never;
  };
  onchain: {
    preimage?: never;
    outpoint?: string;
  };
};

export type GenericMeltMethodFinalizedData = {
  rawFinalResponseData?: Record<string, unknown>;
};

export type MeltMethodFinalizedData<M extends MeltMethod = BuiltInMeltMethod> =
  M extends keyof BuiltInMeltMethodFinalizedDataMap
    ? BuiltInMeltMethodFinalizedDataMap[M]
    : GenericMeltMethodFinalizedData;

// ============================================================================
// State-specific Operation Types
// ============================================================================

/**
 * Initial state - operation just created, nothing reserved yet
 */
export interface InitMeltOperation<
  M extends MeltMethod = BuiltInMeltMethod,
> extends MeltOperationBase<M> {
  state: 'init';
  /** Existing canonical quote to prepare against. */
  quoteId?: string;
}

/**
 * Prepared state - proofs reserved, outputs calculated, ready to execute
 */
export interface PreparedMeltOperation<M extends MeltMethod = BuiltInMeltMethod>
  extends MeltOperationBase<M>, PreparedData {
  state: 'prepared';
}

/**
 * Executing state - swap/token creation in progress
 */
export interface ExecutingMeltOperation<M extends MeltMethod = BuiltInMeltMethod>
  extends MeltOperationBase<M>, PreparedData {
  state: 'executing';
}

/**
 * Pending state - token returned, awaiting confirmation that proofs are spent
 */
export interface PendingMeltOperation<M extends MeltMethod = BuiltInMeltMethod>
  extends MeltOperationBase<M>, PreparedData {
  state: 'pending';
}

/**
 * Finalized state - sent proofs confirmed spent, operation finalized.
 * Contains actual settlement amounts after the melt is complete.
 */
interface FinalizedMeltOperationBase<M extends MeltMethod = BuiltInMeltMethod>
  extends MeltOperationBase<M>, PreparedData {
  state: 'finalized';

  /**
   * Total amount returned as change by the mint.
   * This is the sum of change proofs received from the melt operation.
   * May be 0 if no change was returned.
   * May be undefined for legacy operations finalized before settlement tracking was added.
   */
  changeAmount?: Amount;

  /**
   * Actual fee impact after settlement.
   * Calculated as: inputAmount - amount - changeAmount
   * (total input proofs value - melt amount - change returned)
   * This represents the actual cost paid for the melt, which may differ from fee_reserve.
   * May be undefined for legacy operations finalized before settlement tracking was added.
   */
  effectiveFee?: Amount;
}

export type FinalizedMeltOperation<M extends MeltMethod = BuiltInMeltMethod> =
  FinalizedMeltOperationBase<M> & {
    finalizedData?: MeltMethodFinalizedData<M>;
  };

/**
 * Failed state - melt failed, proofs reclaimed
 */
export interface FailedMeltOperation<M extends MeltMethod = BuiltInMeltMethod>
  extends MeltOperationBase<M>, PreparedData {
  state: 'failed';
}

/**
 * Rolling back state - rollback in progress, reclaim swap being executed.
 * This is a transient state used to prevent race conditions with ProofStateWatcher.
 * Only used when rolling back from 'pending' state (which requires a reclaim swap).
 */
export interface RollingBackMeltOperation<M extends MeltMethod = BuiltInMeltMethod>
  extends MeltOperationBase<M>, PreparedData {
  state: 'rolling_back';
}

/**
 * Rolled back state - operation cancelled, proofs reclaimed
 * Can be rolled back from prepared, executing, or pending states
 */
export interface RolledBackMeltOperation<M extends MeltMethod = BuiltInMeltMethod>
  extends MeltOperationBase<M>, PreparedData {
  state: 'rolled_back';
}

// ============================================================================
// Union Type
// ============================================================================

/**
 * Discriminated union of all melt operation states.
 * TypeScript will narrow the type based on the `state` field.
 */
export type MeltOperation<M extends MeltMethod = BuiltInMeltMethod> =
  | InitMeltOperation<M>
  | PreparedMeltOperation<M>
  | ExecutingMeltOperation<M>
  | PendingMeltOperation<M>
  | FinalizedMeltOperation<M>
  | FailedMeltOperation<M>
  | RollingBackMeltOperation<M>
  | RolledBackMeltOperation<M>;

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Any operation that has been prepared (has PreparedData)
 */
export type PreparedOrLaterOperation<M extends MeltMethod = BuiltInMeltMethod> =
  | PreparedMeltOperation<M>
  | ExecutingMeltOperation<M>
  | PendingMeltOperation<M>
  | FinalizedMeltOperation<M>
  | FailedMeltOperation<M>
  | RollingBackMeltOperation<M>
  | RolledBackMeltOperation<M>;

/**
 * Terminal states - operation is finished
 * Note: 'rolling_back' is NOT terminal - it's a transient state that needs recovery
 */
export type TerminalMeltOperation<M extends MeltMethod = BuiltInMeltMethod> =
  | FinalizedMeltOperation<M>
  | RolledBackMeltOperation<M>
  | FailedMeltOperation<M>;

// ============================================================================
// Type Guards
// ============================================================================

export function isInitOperation<M extends MeltMethod>(
  op: MeltOperation<M>,
): op is InitMeltOperation<M> {
  return op.state === 'init';
}

export function isPreparedOperation<M extends MeltMethod>(
  op: MeltOperation<M>,
): op is PreparedMeltOperation<M> {
  return op.state === 'prepared';
}

export function isExecutingOperation<M extends MeltMethod>(
  op: MeltOperation<M>,
): op is ExecutingMeltOperation<M> {
  return op.state === 'executing';
}

export function isPendingOperation<M extends MeltMethod>(
  op: MeltOperation<M>,
): op is PendingMeltOperation<M> {
  return op.state === 'pending';
}

export function isFinalizedOperation<M extends MeltMethod>(
  op: MeltOperation<M>,
): op is FinalizedMeltOperation<M> {
  return op.state === 'finalized';
}

export function isRollingBackOperation<M extends MeltMethod>(
  op: MeltOperation<M>,
): op is RollingBackMeltOperation<M> {
  return op.state === 'rolling_back';
}

export function isRolledBackOperation<M extends MeltMethod>(
  op: MeltOperation<M>,
): op is RolledBackMeltOperation<M> {
  return op.state === 'rolled_back';
}

/**
 * Check if operation has PreparedData (any state after init)
 */
export function hasPreparedData<M extends MeltMethod>(
  op: MeltOperation<M>,
): op is PreparedOrLaterOperation<M> {
  return op.state !== 'init';
}

/**
 * Check if operation is in a terminal state
 */
export function isTerminalOperation<M extends MeltMethod>(
  op: MeltOperation<M>,
): op is TerminalMeltOperation<M> {
  return op.state === 'finalized' || op.state === 'rolled_back' || op.state === 'failed';
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new SendOperation in init state
 */
export function createMeltOperation<M extends MeltMethod>(
  id: string,
  mintUrl: string,
  meta: MeltMethodMeta<M>,
  unit = DEFAULT_UNIT,
  options?: { quoteId?: string },
): InitMeltOperation<M> {
  const now = Date.now();
  return {
    ...meta,
    id,
    state: 'init',
    mintUrl,
    unit: normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT }),
    ...(options?.quoteId ? { quoteId: options.quoteId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}
