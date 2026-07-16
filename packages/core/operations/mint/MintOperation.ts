/**
 * State machine for mint operations:
 *
 * init -> pending -> executing -> finalized
 *          ^         |
 *          +---------+-> failed
 *
 * - init: Quote-bound local mint intent persisted before prepare has attached quote details
 * - pending: Quote details are durable; a new BOLT11 operation is not attached to an attempt
 * - executing: A durable attempt owns exact outputs while mint or recovery I/O may be in progress
 * - finalized: The exact attempt-attributed proofs and terminal attempt outcome are durable
 * - failed: Operation reached a terminal non-issued state (for example, quote expiry)
 */
export type MintOperationState = 'init' | 'pending' | 'executing' | 'finalized' | 'failed';

import type { Amount } from '@cashu/cashu-ts';
import type { SerializedOutputData } from '../../utils';
import { getSecretsFromSerializedOutputData, normalizeMintUrl } from '../../utils';
import type { MintMethod, MintMethodMeta } from './MintMethodHandler';
import { normalizeUnit, type UnitAmount } from '../../amounts.ts';

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

export interface InitMintOperation<M extends MintMethod = MintMethod>
  extends MintOperationBase<M>, MintIntentData {
  state: 'init';
  quoteId: string;
}

export interface PendingMintOperation<M extends MintMethod = MintMethod>
  extends MintOperationBase<M>, MintIntentData, MintQuoteSnapshot {
  state: 'pending';
}

export interface ExecutingMintOperation<M extends MintMethod = MintMethod>
  extends MintOperationBase<M>, MintIntentData, MintQuoteSnapshot {
  state: 'executing';
}

export interface FinalizedMintOperation<M extends MintMethod = MintMethod>
  extends MintOperationBase<M>, MintIntentData, MintQuoteSnapshot {
  state: 'finalized';
}

export interface FailedMintOperation<M extends MintMethod = MintMethod>
  extends MintOperationBase<M>, MintIntentData, MintQuoteSnapshot {
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

interface MintOperationRecordData {
  /** Durable link to the issuance attempt that owns this operation's exact outputs. */
  attemptId?: string;
}

interface PendingRecordData extends MintOperationRecordData {
  outputData: SerializedOutputData;
}

export type InitMintOperationRecord<M extends MintMethod = MintMethod> = InitMintOperation<M> &
  MintOperationRecordData;
export type PendingMintOperationRecord<M extends MintMethod = MintMethod> =
  PendingMintOperation<M> & PendingRecordData;
export type ExecutingMintOperationRecord<M extends MintMethod = MintMethod> =
  ExecutingMintOperation<M> & PendingRecordData;
export type FinalizedMintOperationRecord<M extends MintMethod = MintMethod> =
  FinalizedMintOperation<M> & PendingRecordData;
export type FailedMintOperationRecord<M extends MintMethod = MintMethod> = FailedMintOperation<M> &
  PendingRecordData;

/** Adapter-facing durable Mint Operation representation. */
export type MintOperationRecord<M extends MintMethod = MintMethod> =
  | InitMintOperationRecord<M>
  | PendingMintOperationRecord<M>
  | ExecutingMintOperationRecord<M>
  | FinalizedMintOperationRecord<M>
  | FailedMintOperationRecord<M>;

export type PendingOrLaterOperationRecord<M extends MintMethod = MintMethod> =
  | PendingMintOperationRecord<M>
  | ExecutingMintOperationRecord<M>
  | FinalizedMintOperationRecord<M>
  | FailedMintOperationRecord<M>;

export type TerminalMintOperationRecord<M extends MintMethod = MintMethod> =
  | FinalizedMintOperationRecord<M>
  | FailedMintOperationRecord<M>;

export function hasPendingData<M extends MintMethod>(
  op: MintOperationRecord<M>,
): op is PendingOrLaterOperationRecord<M> {
  return op.state !== 'init';
}

export function isTerminalOperation<M extends MintMethod>(
  op: MintOperation<M>,
): op is TerminalMintOperation<M> {
  return op.state === 'finalized' || op.state === 'failed';
}

export function getOutputProofSecrets<M extends MintMethod>(
  op: PendingOrLaterOperationRecord<M>,
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
): InitMintOperationRecord<M> {
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

/**
 * Projects a durable Mint Operation record into the app-facing contract.
 *
 * Every public field is selected explicitly so newly persisted orchestration data cannot cross an
 * app boundary by accident.
 */
export function toMintOperation<M extends MintMethod>(
  record: InitMintOperation<M>,
): InitMintOperation<M>;
export function toMintOperation<M extends MintMethod>(
  record: PendingMintOperation<M>,
): PendingMintOperation<M>;
export function toMintOperation<M extends MintMethod>(
  record: ExecutingMintOperation<M>,
): ExecutingMintOperation<M>;
export function toMintOperation<M extends MintMethod>(
  record: FinalizedMintOperation<M>,
): FinalizedMintOperation<M>;
export function toMintOperation<M extends MintMethod>(
  record: FailedMintOperation<M>,
): FailedMintOperation<M>;
export function toMintOperation<M extends MintMethod>(record: MintOperation<M>): MintOperation<M>;
export function toMintOperation<M extends MintMethod>(record: MintOperation<M>): MintOperation<M> {
  const terminalFailure = record.terminalFailure
    ? {
        reason: record.terminalFailure.reason,
        ...(record.terminalFailure.code !== undefined ? { code: record.terminalFailure.code } : {}),
        ...(record.terminalFailure.retryable !== undefined
          ? { retryable: record.terminalFailure.retryable }
          : {}),
        observedAt: record.terminalFailure.observedAt,
      }
    : undefined;
  const base = {
    id: record.id,
    mintUrl: normalizeMintUrl(record.mintUrl),
    method: record.method,
    methodData: record.methodData,
    amount: record.amount,
    unit: record.unit,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(terminalFailure ? { terminalFailure } : {}),
  };

  if (record.state === 'init') {
    return {
      ...base,
      state: 'init',
      quoteId: record.quoteId,
    } as InitMintOperation<M>;
  }

  const quote = {
    quoteId: record.quoteId,
    request: record.request,
    expiry: record.expiry,
    ...(record.pubkey !== undefined ? { pubkey: record.pubkey } : {}),
  };

  return {
    ...base,
    ...quote,
    state: record.state,
  } as PendingOrLaterOperation<M>;
}
