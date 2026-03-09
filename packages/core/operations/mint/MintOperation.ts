/**
 * State machine for mint operations:
 *
 * init -> prepared -> executing -> finalized
 *   |        |           |
 *   +--------+-----------+-> rolled_back
 *
 * - init: Operation created, quote validated
 * - prepared: Deterministic outputData persisted
 * - executing: Mint call in progress
 * - finalized: Proofs saved and quote marked ISSUED
 * - rolled_back: Operation failed or was cancelled
 */
export type MintOperationState =
  | 'init'
  | 'prepared'
  | 'executing'
  | 'finalized'
  | 'rolled_back';

import type { SerializedOutputData } from '../../utils';
import { getSecretsFromSerializedOutputData } from '../../utils';
import type { MintMethod, MintMethodMeta } from './MintMethodHandler';

interface MintOperationBase extends MintMethodMeta {
  id: string;
  mintUrl: string;
  quoteId: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

interface PreparedData {
  amount: number;
  outputData: SerializedOutputData;
}

export interface InitMintOperation extends MintOperationBase {
  state: 'init';
}

export interface PreparedMintOperation extends MintOperationBase, PreparedData {
  state: 'prepared';
}

export interface ExecutingMintOperation extends MintOperationBase, PreparedData {
  state: 'executing';
}

export interface FinalizedMintOperation extends MintOperationBase, PreparedData {
  state: 'finalized';
}

export interface RolledBackMintOperation extends MintOperationBase, PreparedData {
  state: 'rolled_back';
}

export type MintOperation =
  | InitMintOperation
  | PreparedMintOperation
  | ExecutingMintOperation
  | FinalizedMintOperation
  | RolledBackMintOperation;

export type PreparedOrLaterOperation =
  | PreparedMintOperation
  | ExecutingMintOperation
  | FinalizedMintOperation
  | RolledBackMintOperation;

export type TerminalMintOperation = FinalizedMintOperation | RolledBackMintOperation;

export function hasPreparedData(op: MintOperation): op is PreparedOrLaterOperation {
  return op.state !== 'init';
}

export function isTerminalOperation(op: MintOperation): op is TerminalMintOperation {
  return op.state === 'finalized' || op.state === 'rolled_back';
}

export function getOutputProofSecrets(op: PreparedOrLaterOperation): string[] {
  const { keepSecrets, sendSecrets } = getSecretsFromSerializedOutputData(op.outputData);
  return [...keepSecrets, ...sendSecrets];
}

export function createMintOperation<M extends MintMethod>(
  id: string,
  mintUrl: string,
  quoteId: string,
  meta: MintMethodMeta<M>,
): InitMintOperation & MintMethodMeta<M> {
  const now = Date.now();
  return {
    ...meta,
    id,
    state: 'init',
    mintUrl,
    quoteId,
    createdAt: now,
    updatedAt: now,
  };
}
