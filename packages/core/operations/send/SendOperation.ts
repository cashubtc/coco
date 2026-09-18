/**
 * State machine for send operations:
 *
 * init ──► prepared ──► executing ──► pending ──► finalized
 *   │         │            │            │
 *   │         │            │            └──► rolling_back ──► rolled_back
 *   │         │            │                      │
 *   └─────────┴────────────┴──────────────────────┴──► rolled_back
 *
 * - init: Transient operation intent; persisted rows exist only for legacy cleanup
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

import type { Amount, Token } from '@cashu/cashu-ts';
import {
  getSecretsFromSerializedOutputData,
  normalizeMintUrl,
  type SerializedOutputData,
} from '../../utils';
import { normalizeUnit, type UnitAmount } from '../../amounts.ts';
import type { SendMethod, SendMethodData } from './SendMethodHandler';

// ============================================================================
// Base and Data Interfaces
// ============================================================================

/**
 * Base fields present in all send operations
 */
interface SendOperationBase<M extends SendMethod = SendMethod> {
  /** Unique identifier for this operation */
  id: string;

  /** The mint URL for this operation */
  mintUrl: string;

  /** The amount requested to send (before fees) */
  amount: Amount;

  /** Unit for all amounts, proofs, outputs, and token data in this operation. */
  unit: string;

  /** The send method (e.g., 'default', 'p2pk') */
  method: M;

  /** Method-specific data */
  methodData: SendMethodData<M>;

  /** Timestamp when the operation was created */
  createdAt: number;

  /** Timestamp when the operation was last updated */
  updatedAt: number;

  /**
   * Monotonic persistence revision used by conditional state transitions.
   *
   * This remains optional at the public type boundary so operation objects created by older Coco
   * versions remain source-compatible. Repositories normalize a missing legacy revision to 0.
   */
  revision?: number;

  /** Error message if the operation failed */
  error?: string;

  /**
   * Normalized token memo fixed before a swap request is submitted.
   *
   * Swap recovery uses this durable value to reconstruct the same token metadata after a crash
   * between the mint response and the local result transaction.
   */
  executionMemo?: string;

  /** Reclaim's separate output plan; never replaces the original Send request. */
  reclaimData?: {
    inputProofSecrets: string[];
    outputData: SerializedOutputData;
  };
}

/**
 * Data set during the prepare phase
 */
interface PreparedData {
  /** Whether the operation requires a swap (false = exact match send) */
  needsSwap: boolean;

  /** Calculated fee for the swap (0 if exact match) */
  fee: Amount;

  /** Total amount of input proofs selected */
  inputAmount: Amount;

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

/**
 * Token data available once a send has been executed.
 * The token is the canonical shareable copy for default and P2PK sends; the transaction also
 * retains the corresponding inflight proof metadata for completion and Operation Recovery.
 */
interface SendTokenData {
  token?: Token;
}

// ============================================================================
// State-specific Operation Types
// ============================================================================

/**
 * Initial state - operation just created, nothing reserved yet
 */
export interface InitSendOperation extends SendOperationBase {
  state: 'init';
  /**
   * True when the caller supplied this operation ID as a durable command key.
   *
   * Transient: `init` operations are never persisted, so this marker only exists on the in-memory
   * object returned by `SendOperationService.init()` and consumed by `prepare()`. It selects the
   * duplicate-join path instead of the generate-and-fail-fast path.
   */
  callerSuppliedId?: boolean;
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
export interface PendingSendOperation extends SendOperationBase, PreparedData, SendTokenData {
  state: 'pending';
}

/**
 * Finalized state - sent proofs confirmed spent, operation finalized
 */
export interface FinalizedSendOperation extends SendOperationBase, PreparedData, SendTokenData {
  state: 'finalized';
}

/**
 * Rolling back state - rollback in progress, reclaim swap being executed.
 * This is a transient state used to prevent race conditions with ProofStateWatcher.
 * Only used when rolling back from 'pending' state (which requires a reclaim swap).
 */
export interface RollingBackSendOperation extends SendOperationBase, PreparedData, SendTokenData {
  state: 'rolling_back';
}

/**
 * Rolled back state - operation cancelled, proofs reclaimed
 * Can be rolled back from prepared, executing, or pending states
 */
export interface RolledBackSendOperation extends SendOperationBase, PreparedData, SendTokenData {
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

export interface CreateSendOperationOptions<M extends SendMethod = SendMethod> {
  method: M;
  methodData: SendMethodData<M>;
  /**
   * Optional caller-supplied operation ID.
   *
   * When set it becomes the operation identity instead of a generated sub-ID, which lets an
   * embedding host correlate the operation with its own durable command record. See
   * `SendOperationService.prepare()` for the duplicate-join semantics this enables.
   *
   * Must be a non-empty string without surrounding whitespace.
   */
  operationId?: string;
}

/**
 * Creates a new SendOperation in init state
 */
export function createSendOperation<M extends SendMethod = SendMethod>(
  id: string,
  mintUrl: string,
  amount: UnitAmount,
  options: CreateSendOperationOptions<M>,
): InitSendOperation {
  const now = Date.now();
  return {
    id,
    state: 'init',
    mintUrl,
    amount: amount.amount,
    unit: normalizeUnit(amount.unit),
    method: options.method,
    methodData: options.methodData,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    // Transient (never persisted) marker: `init` operations are in-memory only, so this is how
    // `prepare()` knows the ID is a host command key that must resolve against durable state.
    ...(options.operationId === undefined ? {} : { callerSuppliedId: true }),
  };
}

/** Older P2PK recovery could persist pending without a token after all outputs were spent. */
export function isLegacyTokenlessP2pkSend(
  operation: SendOperation,
): operation is PendingSendOperation & { outputData: SerializedOutputData } {
  return (
    operation.state === 'pending' &&
    operation.method === 'p2pk' &&
    operation.needsSwap &&
    (operation.revision ?? 0) === 0 &&
    operation.token == null &&
    !!operation.outputData?.send.length
  );
}

// ============================================================================
// Intent Identity
// ============================================================================

/**
 * Identity-relevant fields of a send intent.
 *
 * Two `init` operations that agree on these fields describe the same requested send. That is what
 * lets a caller-supplied operation ID be re-used for a retry: the persisted operation is joined
 * when the intent matches and reported as a conflict when it does not.
 */
export type SendOperationIntent = Pick<
  SendOperationBase,
  'mintUrl' | 'amount' | 'unit' | 'method' | 'methodData'
>;

/** Compares two send intents, normalizing mint URL, unit, and method data. */
export function isSameSendIntent(a: SendOperationIntent, b: SendOperationIntent): boolean {
  return (
    normalizeMintUrl(a.mintUrl) === normalizeMintUrl(b.mintUrl) &&
    normalizeUnit(a.unit) === normalizeUnit(b.unit) &&
    a.amount.equals(b.amount) &&
    a.method === b.method &&
    canonicalMethodData(a.methodData) === canonicalMethodData(b.methodData)
  );
}

/**
 * Stable string form of method data so key order and `undefined` placeholders alone do not read as
 * a different intent. Repositories persist method data as JSON, which drops those placeholders.
 */
function canonicalMethodData(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalMethodData).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalMethodData(entry)}`)
      .join(',')}}`;
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}
