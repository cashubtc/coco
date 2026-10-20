import type { Amount, MintKeys, OutputDataLike, Proof, Token } from '@cashu/cashu-ts';
import type { CoreProof } from '@core/types.ts';
import type { SerializedOutputData } from '@core/utils.ts';
import type {
  ExecutingSendOperation,
  FinalizedSendOperation,
  InitSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  RolledBackSendOperation,
  RollingBackSendOperation,
} from './SendOperation.ts';

export interface PrepareSendInput {
  operation: InitSendOperation;
  /** Active keys and seed loaded before entering the transaction. */
  activeKeys: MintKeys;
  seed: Uint8Array;
  /** Method policy resolved before entering the transaction. */
  forceSwap: boolean;
  /** Randomized outputs fixed during preflight and reused across transaction retries. */
  fixedSendOutputs?: readonly OutputDataLike[];
  /**
   * Set when the operation ID was caller-supplied, which makes it idempotent: an existing
   * `prepared` operation with the same intent is joined instead of rejected.
   *
   * The marker is passed explicitly so the transition never parses operation identity.
   */
  joinable?: boolean;
}

export interface PrepareSendReservation {
  mintUrl: string;
  operationId: string;
  secrets: string[];
  amount: Amount;
  unit: string;
}

/** Counter advance committed by a creating prepare. Absent when a prepare joins an existing one. */
export interface PrepareSendCounter {
  mintUrl: string;
  keysetId: string;
  counter: number;
}

/**
 * Creating prepares reserve proofs; joining prepares return the already-committed operation and
 * reserve nothing, so `reservation` is non-null exactly when the outcome is `created`.
 */
export type PrepareSendResult =
  | {
      operation: PreparedSendOperation;
      outcome: 'created';
      reservation: PrepareSendReservation;
      counter?: PrepareSendCounter;
    }
  | {
      operation: PreparedSendOperation;
      outcome: 'joined';
      reservation: null;
    };

export interface ExecuteExactSendInput {
  operationId: string;
  updatedAt: number;
  memo?: string;
}

export interface ExecuteExactSendResult {
  operation: PendingSendOperation & { token: Token };
  token: Token;
  /** True when this call changed local state; the outer transaction still owns commit. */
  changed: boolean;
}

export interface BeginSendExecutionInput {
  operationId: string;
  updatedAt: number;
  /** Normalized before entering the retried transaction. */
  memo?: string;
}

export interface ClaimSendRecoveryInput {
  operationId: string;
  expectedRevision: number;
  updatedAt: number;
}

export type ClaimSendRecoveryResult = BeginSendExecutionResult;

export interface RecoverLegacyExactSendInput {
  operationId: string;
  updatedAt: number;
}

export interface RecoverLegacyExactSendResult extends CancelPreparedSendResult {
  readyProofSecrets: string[];
}

export interface SwapTransportRequest {
  mintUrl: string;
  unit: string;
  amount: Amount;
  inputProofs: Proof[];
  outputData: SerializedOutputData;
}

export interface BeginSendExecutionResult {
  operation: ExecutingSendOperation;
  request: SwapTransportRequest;
}

export interface ApplySendResultInput {
  operationId: string;
  updatedAt: number;
  keepProofs: CoreProof[];
  sendProofs: CoreProof[];
  token: Token;
}

export interface ApplySendResult {
  operation: PendingSendOperation;
  savedProofs: CoreProof[];
  /** Existing legacy send outputs moved from ready to inflight by this call. */
  inflightProofSecrets: string[];
  spentInputSecrets: string[];
  /** True when this call changed local state; the outer transaction still owns commit. */
  changed: boolean;
}

export interface FailSendExecutionInput {
  operationId: string;
  expectedRevision: number;
  updatedAt: number;
  error: string;
}

export interface FailSendExecutionResult {
  operation: RolledBackSendOperation;
  releasedInputSecrets: string[];
  /** False when the same terminal failure was already persisted. */
  changed: boolean;
}

export interface CancelPreparedSendInput {
  operationId: string;
  updatedAt: number;
  reason: string;
}

export interface CancelPreparedSendResult {
  operation: RolledBackSendOperation;
  releasedInputSecrets: string[];
  /** False when the same cancellation was already persisted. */
  changed: boolean;
}

export interface CompletePendingSendInput {
  operationId: string;
  updatedAt: number;
  /** Proof-state observations made outside the transaction. */
  spentProofSecrets?: string[];
  /** Full SPENT observation for a legacy tokenless P2PK allocation, pinned before mint I/O. */
  legacyP2pkOutputObservation?: {
    expectedRevision: number;
    mintUrl: string;
    unit: string;
    outputData: SerializedOutputData;
  };
}

export interface CompletePendingSendResult {
  operation: PendingSendOperation | FinalizedSendOperation;
  spentProofSecrets: string[];
  releasedInputSecrets: string[];
  /** True only when this call performed a proof or operation state change. */
  changed: boolean;
}

export interface CleanupLegacySendInitResult {
  operationId: string;
  mintUrl: string;
  releasedProofSecrets: string[];
}

export interface CleanupOrphanedSendReservationsResult {
  released: Array<{ mintUrl: string; secrets: string[] }>;
  count: number;
}

export interface BeginSendReclaimInput {
  operationId: string;
  updatedAt: number;
  activeKeys: MintKeys;
  seed: Uint8Array;
}

export interface BeginSendReclaimResult {
  operation: RollingBackSendOperation;
  inputProofs: CoreProof[];
  counter?: PrepareSendCounter;
  skippedForFees: boolean;
}

export interface CompleteSendReclaimInput {
  operationId: string;
  updatedAt: number;
  reason: string;
  proofs: CoreProof[];
}

export interface CompleteSendReclaimResult {
  operation: RolledBackSendOperation;
  savedProofs: CoreProof[];
  spentProofSecrets: string[];
  releasedProofSecrets: string[];
}
