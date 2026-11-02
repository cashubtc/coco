import type { Amount } from '@cashu/cashu-ts';
import type { SerializedOutputData } from '../../utils.ts';
import type { MintMethod } from '../mint/MintMethodHandler.ts';

/**
 * State machine for Batch Mint Operations:
 *
 * executing -> finalized
 *           +-> failed
 *
 * - executing: Admission, Output Allocation and Mint Quote Reservations committed together; the exact NUT-29 request may have reached the mint.
 * - finalized: The complete validated proof set and each member's local issuance committed.
 * - failed: The mint definitively rejected the exact request; reservations are released.
 *
 * There is no init, prepared or abort state.
 */
export type BatchMintOperationState = 'executing' | 'finalized' | 'failed';

/**
 * An ordered allocation of an amount from one Mint Quote within a Batch Mint Operation. Its Quote
 * Identity is the operation's mint URL and `quoteId`. It has no independent outcome.
 */
export interface BatchMintMember {
  /** Zero-based position in the exact NUT-29 request (`quotes`, `quote_amounts`, `signatures`). */
  ordinal: number;
  quoteId: string;
  /** Claimed amount, sent as this member's `quote_amounts` entry. */
  amount: Amount;
  /** Payment request snapshot of the quote, kept for per-member history. */
  request: string;
  /**
   * NUT-20 public key of a locked quote, or `null` for an unlocked one. As for a Mint Operation, the
   * Wallet signs at submission; neither signatures nor private keys are persisted.
   */
  pubkey: string | null;
}

export interface BatchMintOperationFailure {
  reason: string;
  code?: string;
  observedAt: number;
}

interface BatchMintOperationBase {
  id: string;
  mintUrl: string;
  method: MintMethod;
  unit: string;
  /** Exact ordered membership; repositories hydrate members in ordinal order. */
  members: BatchMintMember[];
  /** One aggregate output set for the whole request. Outputs are never attributed to members. */
  outputData: SerializedOutputData;
  createdAt: number;
  updatedAt: number;
  /** Last unresolved execution or recovery error, retained while the outcome is ambiguous. */
  error?: string;
}

export interface ExecutingBatchMintOperation extends BatchMintOperationBase {
  state: 'executing';
}

export interface FinalizedBatchMintOperation extends BatchMintOperationBase {
  state: 'finalized';
}

export interface FailedBatchMintOperation extends BatchMintOperationBase {
  state: 'failed';
  terminalFailure: BatchMintOperationFailure;
}

export type BatchMintOperation =
  | ExecutingBatchMintOperation
  | FinalizedBatchMintOperation
  | FailedBatchMintOperation;
