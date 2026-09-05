/**
 * init -> pending -> executing -> finalized | failed
 *
 * pending: Immutable outputs are prepared, with durable no-submission provenance.
 * executing: Issuance was authorized and may have reached the mint; retain its reservation.
 * finalized: Complete evidence proves these exact outputs were issued. Spendability is separate.
 * failed: Definitive rejection, with no earlier unresolved submission.
 * Legacy pending operations with unknown submission history migrate to executing.
 */
export type MintOperationState = 'init' | 'pending' | 'executing' | 'finalized' | 'failed';

import type { Amount } from '@cashu/cashu-ts';
import { normalizeUnit, type UnitAmount } from '../../amounts.ts';
import type { SerializedOutputData } from '../../utils';
import { getSecretsFromSerializedOutputData } from '../../utils';
import type { MintMethod, MintMethodMeta } from './MintMethodHandler';

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
  amount: Amount;
  unit: string;
}

interface MintQuoteSnapshot {
  quoteId: string;
  request: string;
  expiry: number | null;
  pubkey?: string;
}

interface PendingData {
  outputData: SerializedOutputData;
}

export interface InitMintOperation<M extends MintMethod = MintMethod>
  extends MintOperationBase<M>, MintIntentData {
  state: 'init';
  quoteId: string;
}

export interface PendingMintOperation<M extends MintMethod = MintMethod>
  extends MintOperationBase<M>, MintIntentData, MintQuoteSnapshot, PendingData {
  state: 'pending';
}

export interface ExecutingMintOperation<M extends MintMethod = MintMethod>
  extends MintOperationBase<M>, MintIntentData, MintQuoteSnapshot, PendingData {
  state: 'executing';
}

export interface FinalizedMintOperation<M extends MintMethod = MintMethod>
  extends MintOperationBase<M>, MintIntentData, MintQuoteSnapshot, PendingData {
  state: 'finalized';
}

export interface FailedMintOperation<M extends MintMethod = MintMethod>
  extends MintOperationBase<M>, MintIntentData, MintQuoteSnapshot, PendingData {
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
  intent: UnitAmount,
  options: { quoteId: string },
): InitMintOperation<M> {
  const now = Date.now();
  return {
    ...meta,
    ...intent,
    amount: intent.amount,
    unit: normalizeUnit(intent.unit),
    quoteId: options.quoteId,
    id,
    state: 'init',
    mintUrl,
    createdAt: now,
    updatedAt: now,
  };
}
