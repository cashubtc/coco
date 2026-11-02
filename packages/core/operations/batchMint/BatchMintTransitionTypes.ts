import type { Amount, MintKeys, Proof } from '@cashu/cashu-ts';
import type { Counter } from '../../models/Counter.ts';
import type { CoreProof } from '../../types.ts';
import type { MintMethod } from '../mint/MintMethodHandler.ts';
import type {
  BatchMintOperation,
  BatchMintOperationFailure,
  ExecutingBatchMintOperation,
  FinalizedBatchMintOperation,
} from './BatchMintOperation.ts';

export interface AdmitBatchMintInput {
  operationId: string;
  mintUrl: string;
  method: MintMethod;
  unit: string;
  /** Exact caller order; an omitted amount claims the member's full available amount. */
  members: Array<{ quoteId: string; amount?: Amount }>;
  activeKeys: MintKeys;
  seed: Uint8Array;
  now: number;
}

export interface AdmitBatchMintResult {
  operation: ExecutingBatchMintOperation;
  counter?: Counter;
}

export interface ApplyBatchMintResultInput {
  operation: ExecutingBatchMintOperation;
  proofs: Proof[];
  now: number;
}

export interface ApplyBatchMintResult {
  operation: FinalizedBatchMintOperation;
  proofs: CoreProof[];
  changed: boolean;
}

export interface FailBatchMintInput {
  operationId: string;
  failure: BatchMintOperationFailure;
  now: number;
}

export interface FailBatchMintResult {
  operation: BatchMintOperation;
  changed: boolean;
}

export interface DeferBatchMintRecoveryInput {
  operation: ExecutingBatchMintOperation;
  error?: string;
  now: number;
}
