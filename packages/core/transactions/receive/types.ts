import type { MintKeys, Proof } from '@cashu/cashu-ts';
import type {
  InitReceiveOperation,
  PreparedReceiveOperation,
  ExecutingReceiveOperation,
  FinalizedReceiveOperation,
  RolledBackReceiveOperation,
} from '@core/operations/receive/ReceiveOperation.ts';
import type { CoreProof } from '@core/types.ts';
import type { SerializedOutputData } from '@core/utils.ts';

export interface PrepareReceiveCommand {
  /** Exact signed request assembled during asynchronous preflight. */
  operation: InitReceiveOperation;
  /** Active output keys and seed loaded before entering the transaction. */
  activeKeys: MintKeys;
  seed: Uint8Array;
}

export interface PreparedReceiveResult {
  operation: PreparedReceiveOperation;
  counter: { mintUrl: string; keysetId: string; counter: number };
}

export interface BeginReceiveExecutionCommand {
  operationId: string;
  updatedAt: number;
}

/** Exact durable request submitted to the mint outside the transaction. */
export interface ReceiveTransportRequest {
  mintUrl: string;
  unit: string;
  inputProofs: Proof[];
  outputData: SerializedOutputData;
}

export interface BegunReceiveExecution {
  operation: ExecutingReceiveOperation;
  request: ReceiveTransportRequest;
}

export interface ApplyReceiveResultCommand {
  operationId: string;
  updatedAt: number;
  proofs: CoreProof[];
}

export interface AppliedReceiveResult {
  operation: FinalizedReceiveOperation;
  /** Proofs inserted by this call; empty for an idempotent duplicate. */
  savedProofs: CoreProof[];
  committed: boolean;
}

export interface FailReceiveExecutionCommand {
  operationId: string;
  updatedAt: number;
  error: string;
}

export interface CancelPreparedReceiveCommand {
  operationId: string;
  updatedAt: number;
  error: string;
}

export interface FailedReceiveExecution {
  operation: RolledBackReceiveOperation;
  committed: boolean;
}
