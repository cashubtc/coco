import { Amount } from '@cashu/cashu-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type {
  MintSwapAttention,
  MintSwapOperation,
  MintSwapRetryError,
  MintSwapRetryState,
} from './MintSwapOperation.ts';
import { isMintSwapAutomaticState } from './MintSwapOperation.ts';
import { parseMintSwapOperation } from './parseMintSwapOperation.ts';
import type { PreparedOrLaterOperation } from '../melt/MeltOperation.ts';
import { normalizeMintUrl } from '../../utils.ts';

export interface MintSwapIntent {
  id: string;
  sourceMintUrl: string;
  destinationMintUrl: string;
  destinationAmount: Amount;
  sourceDebitCap?: Amount;
}

export function normalizeMintSwapIntent(input: MintSwapIntent): MintSwapIntent {
  const intent = {
    id: input.id,
    sourceMintUrl: normalizeMintUrl(input.sourceMintUrl),
    destinationMintUrl: normalizeMintUrl(input.destinationMintUrl),
    destinationAmount: Amount.from(input.destinationAmount),
    ...(input.sourceDebitCap === undefined
      ? {}
      : { sourceDebitCap: Amount.from(input.sourceDebitCap) }),
  };
  if (
    !intent.id.trim() ||
    intent.sourceMintUrl === intent.destinationMintUrl ||
    intent.destinationAmount.isZero() ||
    intent.sourceDebitCap?.lessThan(intent.destinationAmount)
  )
    throw new TypeError('Invalid Mint Swap intent');
  return intent;
}

export class MintSwapIntentConflictError extends Error {
  constructor() {
    super('Mint Swap ID belongs to a different intent');
    this.name = 'MintSwapIntentConflictError';
  }
}

export function assertMintSwapIntent(operation: MintSwapOperation, intent: MintSwapIntent): void {
  if (
    operation.id !== intent.id ||
    operation.sourceMintUrl !== intent.sourceMintUrl ||
    operation.destinationMintUrl !== intent.destinationMintUrl ||
    !operation.destinationAmount.equals(intent.destinationAmount) ||
    operation.sourceDebitCap?.toString() !== intent.sourceDebitCap?.toString()
  )
    throw new MintSwapIntentConflictError();
}

export class MintSwapInvariantError extends Error {
  constructor(
    readonly invariant: MintSwapAttention['invariant'],
    readonly code: MintSwapAttention['evidence']['code'],
    readonly leg: 'source' | 'destination',
  ) {
    super(`Mint Swap ${leg} ${invariant}: ${code}`);
    this.name = 'MintSwapInvariantError';
  }
  evidence(now: number): MintSwapAttention {
    return {
      reason: [
        'child_missing',
        'quote_missing',
        'key_missing',
        'outputs_missing',
        'proofs_missing',
      ].includes(this.code)
        ? 'missing_recovery_material'
        : 'contradictory_evidence',
      invariant: this.invariant,
      evidence: { code: this.code, leg: this.leg, observedAt: now },
    };
  }
}

export function invoiceHash(request: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(request)));
}

export function initialMintSwapRetry(
  state: MintSwapOperation['state'],
  now: number,
): MintSwapRetryState {
  return {
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: isMintSwapAutomaticState(state) ? now : null,
    lastError: null,
  };
}

export function advanceMintSwap(
  current: MintSwapOperation,
  state: MintSwapOperation['state'],
  now: number,
  facts: object = {},
): MintSwapOperation {
  const at = Math.max(now, current.updatedAt);
  return parseMintSwapOperation({
    ...current,
    ...facts,
    state,
    updatedAt: at,
    stateEnteredAt: at,
    retry: initialMintSwapRetry(state, at),
  });
}

export function stopMintSwap(
  current: MintSwapOperation,
  state: 'cancelled' | 'failed' | 'needs_attention',
  now: number,
  facts: object,
): MintSwapOperation {
  const {
    sourceDebitBounds,
    sourceStartedAt,
    sourceSettlement,
    destinationStartedAt,
    destinationCompletion: _completion,
    completedAt: _completed,
    ...base
  } = current;
  const lastSafe = {
    state: current.state,
    stateEnteredAt: current.stateEnteredAt,
    ...(sourceDebitBounds ? { sourceDebitBounds } : {}),
    ...(sourceStartedAt === undefined ? {} : { sourceStartedAt }),
    ...(sourceSettlement ? { sourceSettlement } : {}),
    ...(destinationStartedAt === undefined ? {} : { destinationStartedAt }),
  };
  return advanceMintSwap(base as MintSwapOperation, state, now, { lastSafe, ...facts });
}

/** Fixed entropy and clock per owning attempt; Retry-After is an absolute lower bound. */
export function scheduleMintSwapRetry(
  current: MintSwapOperation,
  error: Omit<MintSwapRetryError, 'at'>,
  now: number,
  random: number,
  retryAfter?: number,
): MintSwapOperation {
  if (!isMintSwapAutomaticState(current.state)) return current;
  if (!Number.isFinite(random) || random < 0 || random >= 1)
    throw new TypeError('Invalid retry entropy');
  const at = Math.max(now, current.updatedAt, (current.retry.lastAttemptAt ?? -1) + 1);
  const attemptCount = current.retry.attemptCount + 1;
  const base = error.category === 'waiting' ? 2_000 : 1_000;
  const cap = error.category === 'waiting' ? 300_000 : 30_000;
  const delay = Math.max(
    1,
    Math.floor(random * Math.min(cap, base * 2 ** Math.min(attemptCount - 1, 20))),
  );
  return parseMintSwapOperation({
    ...current,
    updatedAt: at,
    retry: {
      attemptCount,
      lastAttemptAt: at,
      nextAttemptAt: Math.max(at + delay, retryAfter ?? 0),
      lastError: { ...error, at },
    },
  });
}

export function meltPlanAmounts(operation: PreparedOrLaterOperation) {
  const keep = Amount.sum(
    (operation.swapOutputData?.keep ?? []).map((output) =>
      Amount.from(output.blindedMessage.amount),
    ),
  );
  const melt = operation.needsSwap
    ? Amount.sum(
        (operation.swapOutputData?.send ?? []).map((output) =>
          Amount.from(output.blindedMessage.amount),
        ),
      )
    : operation.inputAmount;
  if (!keep.add(melt).add(operation.swap_fee).equals(operation.inputAmount))
    throw new MintSwapInvariantError('source_debit', 'debit_bounds_mismatch', 'source');
  return { keep, melt };
}
