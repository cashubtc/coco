import type { Amount, MintKeys, Proof } from '@cashu/cashu-ts';
import type { Counter } from '@core/models/Counter.ts';
import type { CoreProof } from '@core/types.ts';
import type {
  ExecutingMeltOperation,
  FinalizedMeltOperation,
  MeltMethodFinalizedData,
  MeltOperation,
  PendingMeltOperation,
  PreparedMeltOperation,
  RolledBackMeltOperation,
} from './MeltOperation.ts';
import type { MeltMethod, MeltMethodData } from './MeltMethodHandler.ts';

export interface PrepareMeltInput<M extends MeltMethod = MeltMethod> {
  operationId: string;
  mintUrl: string;
  method: M;
  methodData: MeltMethodData<M>;
  quoteId: string;
  unit: string;
  activeKeys: MintKeys;
  seed: Uint8Array;
  now: number;
}

export interface PrepareMeltResult {
  operation: PreparedMeltOperation;
  reservedProofs: CoreProof[];
  counter?: Counter;
  changed: boolean;
}

export interface BeginMeltExecutionInput {
  operationId: string;
  now: number;
}

export interface BeginMeltExecutionResult {
  operation: MeltOperation;
  inputProofs: CoreProof[];
  changed: boolean;
}

export interface ApplyMeltSwapResultInput {
  operation: ExecutingMeltOperation;
  keepProofs: Proof[];
  sendProofs: Proof[];
  now: number;
}

export interface ApplyMeltSwapResult {
  operation: ExecutingMeltOperation;
  savedProofs: CoreProof[];
  sendProofs: CoreProof[];
  spentInputSecrets: string[];
  changed: boolean;
}

export interface ApplyMeltPendingInput {
  operation: ExecutingMeltOperation;
  now: number;
}

export interface ApplyMeltPendingResult {
  operation: MeltOperation;
  changed: boolean;
}

export interface ApplyMeltPaidResultInput<M extends MeltMethod = MeltMethod> {
  operation: ExecutingMeltOperation | PendingMeltOperation;
  changeProofs: Proof[];
  finalizedData?: MeltMethodFinalizedData<M>;
  now: number;
}

export interface ApplyMeltPaidResult {
  operation: FinalizedMeltOperation;
  changeProofs: CoreProof[];
  spentInputSecrets: string[];
  changed: boolean;
}

export interface MeltNonPaymentEvidence {
  kind: 'melt-response-unpaid' | 'quote-observation-unpaid';
  mintUrl: string;
  method: MeltMethod;
  quoteId: string;
  observedAt: number;
  /** Required when a pre-swap was authorized but no complete swap result was persisted. */
  originalProofsUnspent?: boolean;
}

export interface ReleaseMeltAfterNonPaymentInput {
  operationId: string;
  evidence: MeltNonPaymentEvidence;
  reason: string;
  now: number;
}

export interface ReleaseMeltAfterNonPaymentResult {
  operation: MeltOperation;
  restoredSecrets: string[];
  releasedSecrets: string[];
  changed: boolean;
}

export interface CancelPreparedMeltInput {
  operationId: string;
  reason: string;
  now: number;
}

export interface CancelPreparedMeltResult {
  operation: MeltOperation;
  restoredSecrets: string[];
  releasedSecrets: string[];
  changed: boolean;
}

export interface DeferMeltRecoveryInput {
  operationId: string;
  error?: string;
  now: number;
}

export interface CleanupMeltInitResult {
  releasedSecrets: string[];
  changed: boolean;
}

export type TerminalMeltRollback = RolledBackMeltOperation;
