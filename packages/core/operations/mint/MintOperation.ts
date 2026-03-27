/**
 * State machine for mint operations:
 *
 * init -> pending -> executing -> finalized
 *          ^         |
 *          +---------+-> failed
 *
 * - init: Local mint intent persisted before prepare has attached a quote snapshot
 * - pending: Deterministic outputData persisted; quote may now settle remotely
 * - executing: Mint or recovery call in progress
 * - finalized: Quote reached terminal ISSUED state; proofs were saved when recoverable
 * - failed: Operation reached a terminal non-issued state (for example, quote expiry)
 */
export type MintOperationState = 'init' | 'pending' | 'executing' | 'finalized' | 'failed';

import type { SerializedOutputData } from '../../utils';
import { getSecretsFromSerializedOutputData } from '../../utils';
import type { MintMethod, MintMethodMeta, MintMethodRemoteState } from './MintMethodHandler';

interface MintOperationBase<M extends MintMethod = MintMethod> extends MintMethodMeta<M> {
  id: string;
  mintUrl: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  terminalFailure?: MintOperationFailure;
}

export interface MintOperationFailure {
  reason: string;
  code?: string;
  retryable?: boolean;
  observedAt: number;
}

interface MintIntentData {
  amount: number;
  unit: string;
}

interface MintQuoteSnapshot {
  quoteId: string;
  request: string;
  expiry: number;
  pubkey?: string;
}

interface MintRemoteObservation<M extends MintMethod = MintMethod> {
  lastObservedRemoteState?: MintMethodRemoteState<M>;
  lastObservedRemoteStateAt?: number;
}

interface PendingData {
  outputData: SerializedOutputData;
}

export interface InitMintOperation<M extends MintMethod = MintMethod>
  extends MintOperationBase<M>, MintIntentData {
  state: 'init';
  quoteId?: string;
}

export interface PendingMintOperation<M extends MintMethod = MintMethod>
  extends
    MintOperationBase<M>,
    MintIntentData,
    MintQuoteSnapshot,
    MintRemoteObservation<M>,
    PendingData {
  state: 'pending';
}

export interface ExecutingMintOperation<M extends MintMethod = MintMethod>
  extends
    MintOperationBase<M>,
    MintIntentData,
    MintQuoteSnapshot,
    MintRemoteObservation<M>,
    PendingData {
  state: 'executing';
}

export interface FinalizedMintOperation<M extends MintMethod = MintMethod>
  extends
    MintOperationBase<M>,
    MintIntentData,
    MintQuoteSnapshot,
    MintRemoteObservation<M>,
    PendingData {
  state: 'finalized';
}

export interface FailedMintOperation<M extends MintMethod = MintMethod>
  extends
    MintOperationBase<M>,
    MintIntentData,
    MintQuoteSnapshot,
    MintRemoteObservation<M>,
    PendingData {
  state: 'failed';
}

export type MintOperation<M extends MintMethod = MintMethod> =
  | InitMintOperation<M>
  | PendingMintOperation<M>
  | ExecutingMintOperation<M>
  | FinalizedMintOperation<M>
  | FailedMintOperation<M>;

export type PendingOrLaterOperation<M extends MintMethod = MintMethod> =
  | PendingMintOperation<M>
  | ExecutingMintOperation<M>
  | FinalizedMintOperation<M>
  | FailedMintOperation<M>;

export type TerminalMintOperation<M extends MintMethod = MintMethod> =
  | FinalizedMintOperation<M>
  | FailedMintOperation<M>;

export function hasPendingData<M extends MintMethod>(
  op: MintOperation<M>,
): op is PendingOrLaterOperation<M> {
  return op.state !== 'init';
}

export function isTerminalOperation<M extends MintMethod>(
  op: MintOperation<M>,
): op is TerminalMintOperation<M> {
  return op.state === 'finalized' || op.state === 'failed';
}

export function getOutputProofSecrets<M extends MintMethod>(
  op: PendingOrLaterOperation<M>,
): string[] {
  const { keepSecrets, sendSecrets } = getSecretsFromSerializedOutputData(op.outputData);
  return [...keepSecrets, ...sendSecrets];
}

export function createMintOperation<M extends MintMethod>(
  id: string,
  mintUrl: string,
  meta: MintMethodMeta<M>,
  intent: MintIntentData,
  options?: { quoteId?: string },
): InitMintOperation<M> {
  const now = Date.now();
  return {
    ...meta,
    ...intent,
    ...(options?.quoteId ? { quoteId: options.quoteId } : {}),
    id,
    state: 'init',
    mintUrl,
    createdAt: now,
    updatedAt: now,
  };
}
