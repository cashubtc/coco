import { Amount } from '@cashu/cashu-ts';
import { normalizeUnit } from '../../amounts.ts';
import { normalizeMintUrl, type SerializedOutputData } from '../../utils.ts';
import type { MintMethod } from './MintMethodHandler.ts';

/** Durable lifecycle states for a Mint Issuance Attempt. */
export type MintIssuanceAttemptState =
  | 'prepared'
  | 'submitting'
  | 'recovering'
  | 'succeeded'
  | 'rejected'
  | 'failed';

/** Future per-member signing input retained for NUT-20 request construction. */
export interface MintIssuanceSigningRequirement {
  kind: 'nut20';
  pubkey: string;
}

/** Transport metadata needed to rebuild the exact single or batch request. */
export type MintIssuanceRequestMetadata =
  | {
      kind: 'single';
      quoteId: string;
    }
  | {
      kind: 'batch';
      quoteIds: string[];
      quoteAmounts: Amount[];
    };

/** Structured terminal failure retained with a rejected or locally failed attempt. */
export interface MintIssuanceAttemptError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

/**
 * Durable, adapter-facing record for one exact mint issuance boundary.
 *
 * This is recovery material and must never be included in an app-facing Mint Operation.
 */
export interface MintIssuanceAttempt {
  id: string;
  mintUrl: string;
  method: MintMethod;
  unit: string;
  keysetId: string;
  state: MintIssuanceAttemptState;
  memberOperationIds: string[];
  quoteIds: string[];
  quoteAmounts: Amount[];
  signingRequirements: Array<MintIssuanceSigningRequirement | null>;
  outputData: SerializedOutputData;
  /** Inclusive deterministic counter start, absent when legacy history cannot prove the range. */
  counterStart?: number;
  /** Exclusive deterministic counter end, absent when legacy history cannot prove the range. */
  counterEnd?: number;
  request: MintIssuanceRequestMetadata;
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  recoveryStartedAt?: number;
  recoveredAt?: number;
  terminalError?: MintIssuanceAttemptError;
}

/** States that require submission or exact-output recovery after restart. */
export const RECOVERABLE_MINT_ISSUANCE_ATTEMPT_STATES = [
  'prepared',
  'submitting',
  'recovering',
] as const satisfies readonly MintIssuanceAttemptState[];

function cloneOutputData(outputData: SerializedOutputData): SerializedOutputData {
  return {
    keep: outputData.keep.map((output) => ({
      ...output,
      blindedMessage: { ...output.blindedMessage },
    })),
    send: outputData.send.map((output) => ({
      ...output,
      blindedMessage: { ...output.blindedMessage },
    })),
  };
}

function cloneRequest(request: MintIssuanceRequestMetadata): MintIssuanceRequestMetadata {
  if (request.kind === 'single') return { ...request };
  return {
    kind: 'batch',
    quoteIds: [...request.quoteIds],
    quoteAmounts: request.quoteAmounts.map((amount) => Amount.from(amount)),
  };
}

function assertNonEmptyUnique(values: string[], field: string): void {
  if (values.length === 0) throw new Error(`${field} must not be empty`);
  if (values.some((value) => value.trim().length === 0)) {
    throw new Error(`${field} must not contain empty values`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${field} must contain unique values`);
  }
}

/** Validates, normalizes, and defensively clones an adapter-facing attempt record. */
export function normalizeMintIssuanceAttempt(attempt: MintIssuanceAttempt): MintIssuanceAttempt {
  assertNonEmptyUnique(attempt.memberOperationIds, 'memberOperationIds');
  assertNonEmptyUnique(attempt.quoteIds, 'quoteIds');
  const memberCount = attempt.memberOperationIds.length;
  if (
    attempt.quoteIds.length !== memberCount ||
    attempt.quoteAmounts.length !== memberCount ||
    attempt.signingRequirements.length !== memberCount
  ) {
    throw new Error('Mint issuance attempt member metadata must have matching lengths');
  }
  const hasCounterStart = attempt.counterStart !== undefined;
  const hasCounterEnd = attempt.counterEnd !== undefined;
  if (hasCounterStart !== hasCounterEnd) {
    throw new Error('Mint issuance attempt counter range must be wholly known or wholly unknown');
  }
  if (hasCounterStart && hasCounterEnd) {
    const counterStart = attempt.counterStart!;
    const counterEnd = attempt.counterEnd!;
    if (!Number.isSafeInteger(counterStart) || counterStart < 0) {
      throw new Error('counterStart must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(counterEnd) || counterEnd < counterStart) {
      throw new Error('counterEnd must be a safe integer at or after counterStart');
    }
    const outputCount = attempt.outputData.keep.length + attempt.outputData.send.length;
    if (counterEnd - counterStart !== outputCount) {
      throw new Error('Mint issuance attempt counter range must exactly cover persisted outputs');
    }
  }
  if (attempt.request.kind === 'single') {
    if (memberCount !== 1 || attempt.request.quoteId !== attempt.quoteIds[0]) {
      throw new Error('Single request metadata must identify the attempt quote');
    }
  } else {
    if (
      attempt.request.quoteIds.length !== attempt.quoteIds.length ||
      attempt.request.quoteAmounts.length !== attempt.quoteAmounts.length ||
      attempt.request.quoteIds.some((quoteId, index) => quoteId !== attempt.quoteIds[index]) ||
      attempt.request.quoteAmounts.some(
        (amount, index) => !amount.equals(attempt.quoteAmounts[index]!),
      )
    ) {
      throw new Error('Batch request metadata must preserve the attempt quote order and amounts');
    }
  }

  return {
    ...attempt,
    mintUrl: normalizeMintUrl(attempt.mintUrl),
    unit: normalizeUnit(attempt.unit),
    memberOperationIds: [...attempt.memberOperationIds],
    quoteIds: [...attempt.quoteIds],
    quoteAmounts: attempt.quoteAmounts.map((amount) => Amount.from(amount)),
    signingRequirements: attempt.signingRequirements.map((requirement) =>
      requirement ? { ...requirement } : null,
    ),
    outputData: cloneOutputData(attempt.outputData),
    request: cloneRequest(attempt.request),
    terminalError: attempt.terminalError
      ? {
          ...attempt.terminalError,
          details: attempt.terminalError.details ? { ...attempt.terminalError.details } : undefined,
        }
      : undefined,
  };
}

function recoveryMaterial(attempt: MintIssuanceAttempt): Record<string, unknown> {
  const normalized = normalizeMintIssuanceAttempt(attempt);
  return {
    id: normalized.id,
    mintUrl: normalized.mintUrl,
    method: normalized.method,
    unit: normalized.unit,
    keysetId: normalized.keysetId,
    memberOperationIds: normalized.memberOperationIds,
    quoteIds: normalized.quoteIds,
    quoteAmounts: normalized.quoteAmounts.map((amount) => amount.toString()),
    signingRequirements: normalized.signingRequirements,
    outputData: normalized.outputData,
    counterStart: normalized.counterStart,
    counterEnd: normalized.counterEnd,
    request:
      normalized.request.kind === 'single'
        ? normalized.request
        : {
            ...normalized.request,
            quoteAmounts: normalized.request.quoteAmounts.map((amount) => amount.toString()),
          },
    createdAt: normalized.createdAt,
  };
}

/** Rejects an update that would rewrite the exact evidence needed for recovery. */
export function assertMintIssuanceAttemptRecoveryMaterialUnchanged(
  existing: MintIssuanceAttempt,
  updated: MintIssuanceAttempt,
): void {
  if (JSON.stringify(recoveryMaterial(existing)) !== JSON.stringify(recoveryMaterial(updated))) {
    throw new Error('Mint issuance attempt recovery material is immutable after creation');
  }
}
