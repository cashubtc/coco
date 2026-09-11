import type { Amount, MintKeys, OutputDataLike, Proof, Token } from '@cashu/cashu-ts';
import type {
  ExecutingSendOperation,
  FinalizedSendOperation,
  InitSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  RollingBackSendOperation,
  RolledBackSendOperation,
} from '@core/operations/send/SendOperation.ts';
import type { CoreProof } from '@core/types.ts';
import type { SerializedOutputData } from '@core/utils.ts';

export interface PrepareSendInput {
  operation: InitSendOperation;
  /** Active keys and seed loaded before entering the transaction. */
  activeKeys: MintKeys;
  seed: Uint8Array;
  /** Method policy resolved before entering the transaction. */
  forceSwap: boolean;
  /** Randomized outputs fixed during preflight and reused across transaction retries. */
  fixedSendOutputs?: readonly OutputDataLike[];
}

export interface PreparedSendResult {
  operation: PreparedSendOperation;
  reservation: {
    mintUrl: string;
    operationId: string;
    secrets: string[];
    amount: Amount;
    unit: string;
  };
  counter?: { mintUrl: string; keysetId: string; counter: number };
}

export interface ExecuteExactSendInput {
  operationId: string;
  updatedAt: number;
  memo?: string;
}

export interface ExecuteExactSendResult {
  operation: PendingSendOperation & { token: Token };
  token: Token;
  /** False when an equivalent pending result had already committed. */
  committed: boolean;
}

export interface BeginSwapExecutionInput {
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

export interface RecoverLegacyExactSendInput {
  operationId: string;
  updatedAt: number;
}

export interface RecoveredLegacyExactSend extends CancelledPreparedSend {
  readyProofSecrets: string[];
}

export interface SwapTransportRequest {
  mintUrl: string;
  unit: string;
  amount: Amount;
  inputProofs: Proof[];
  outputData: SerializedOutputData;
}

export interface BegunSwapExecution {
  operation: ExecutingSendOperation;
  request: SwapTransportRequest;
}

export interface ApplySwapResultInput {
  operationId: string;
  updatedAt: number;
  keepProofs: CoreProof[];
  sendProofs: CoreProof[];
  token: Token;
}

export interface AppliedSwapResult {
  operation: PendingSendOperation;
  savedProofs: CoreProof[];
  spentInputSecrets: string[];
  /** False when an equivalent result had already committed. */
  committed: boolean;
}

export interface FailSwapExecutionInput {
  operationId: string;
  expectedRevision: number;
  updatedAt: number;
  error: string;
}

export interface FailedSwapExecution {
  operation: RolledBackSendOperation;
  releasedInputSecrets: string[];
  /** False when the same terminal failure had already committed. */
  committed: boolean;
}

export interface CancelPreparedSendInput {
  operationId: string;
  updatedAt: number;
  reason: string;
}

export interface CancelledPreparedSend {
  operation: RolledBackSendOperation;
  releasedInputSecrets: string[];
  /** False when the same cancellation had already committed. */
  committed: boolean;
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

export interface CompletedPendingSend {
  operation: PendingSendOperation | FinalizedSendOperation;
  spentProofSecrets: string[];
  releasedInputSecrets: string[];
  /** True only when this call performed a proof or operation state change. */
  committed: boolean;
}

export interface CleanupLegacyInitResult {
  operationId: string;
  mintUrl: string;
  releasedProofSecrets: string[];
}

export interface CleanupOrphanedSendReservationsResult {
  released: Array<{ mintUrl: string; secrets: string[] }>;
  count: number;
}

export interface BeginReclaimInput {
  operationId: string;
  updatedAt: number;
  activeKeys: MintKeys;
  seed: Uint8Array;
}

export interface BegunReclaim {
  operation: RollingBackSendOperation;
  inputProofs: CoreProof[];
  counter?: PreparedSendResult['counter'];
  skippedForFees: boolean;
}

export interface CompleteReclaimInput {
  operationId: string;
  updatedAt: number;
  reason: string;
  proofs: CoreProof[];
}

export interface CompletedReclaim {
  operation: RolledBackSendOperation;
  savedProofs: CoreProof[];
  spentProofSecrets: string[];
  releasedProofSecrets: string[];
}
