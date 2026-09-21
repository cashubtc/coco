import type { MintKeys } from '@cashu/cashu-ts';
import type { Counter } from '@core/models/Counter.ts';
import type {
  InitReceiveOperation,
  PreparedReceiveOperation,
  FinalizedReceiveOperation,
} from '@core/operations/receive/ReceiveOperation.ts';
import type { CoreProof } from '@core/types.ts';

export interface PrepareReceiveInput {
  operation: InitReceiveOperation;
  activeKeys: MintKeys;
  seed: Uint8Array;
  updatedAt: number;
}

export interface ReceiveOperationInput {
  operationId: string;
  updatedAt: number;
}

export interface ClaimReceiveRecoveryInput extends ReceiveOperationInput {
  expectedRevision: number;
}

export interface ApplyReceiveResultInput extends ReceiveOperationInput {
  /** Validated remote candidates; missing outputs may already exist in local storage. */
  proofs: CoreProof[];
}

export interface FailReceiveInput extends ClaimReceiveRecoveryInput {
  /** Caller has established non-effect of this request, not just a failed replay. */
  error: string;
}

export interface PreparedReceiveResult {
  operation: PreparedReceiveOperation;
  counter: Counter;
}

export interface AppliedReceiveResult {
  operation: FinalizedReceiveOperation;
  committed: boolean;
  savedProofs: CoreProof[];
  spentSecrets: string[];
}
