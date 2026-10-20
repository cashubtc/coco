import type { Amount, MintKeys, Proof } from '@cashu/cashu-ts';
import type { Counter } from '@core/models/Counter.ts';
import type { CoreProof } from '@core/types.ts';
import type { MintMethod } from '@core/operations/mint/MintMethodHandler.ts';
import type {
  ExecutingMintOperation,
  MintOperationFailure,
  PendingMintOperation,
  MintOperation,
  FinalizedMintOperation,
  TerminalMintOperation,
} from '@core/operations/mint/MintOperation.ts';

export interface PrepareMintInput {
  operationId: string;
  mintUrl: string;
  method: MintMethod;
  quoteId: string;
  amount: Amount;
  unit: string;
  activeKeys: MintKeys;
  seed: Uint8Array;
  now: number;
}

export interface BeginMintExecutionInput {
  operationId: string;
  now: number;
}

export interface ApplyMintResultInput {
  operation: ExecutingMintOperation;
  proofs: Proof[];
  now: number;
}

export interface FailMintInput {
  operationId: string;
  expectedState: 'pending' | 'executing';
  failure: MintOperationFailure;
  now: number;
}

export interface PrepareMintResult {
  operation: PendingMintOperation;
  counter?: Counter;
  changed: boolean;
}
export interface BeginMintExecutionResult {
  operation: MintOperation;
  changed: boolean;
}
export interface ApplyMintResult {
  operation: FinalizedMintOperation;
  proofs: CoreProof[];
  changed: boolean;
}
export interface FailMintResult {
  operation: TerminalMintOperation;
  changed: boolean;
}
export interface DeferMintRecoveryInput {
  operation: ExecutingMintOperation;
  error?: string;
  now: number;
}
