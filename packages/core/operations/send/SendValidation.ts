import { Amount, sumProofs, type Proof, type Token } from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { normalizeMintUrl } from '@core/utils.ts';
import { ProofValidationError, SendOperationConflictError } from '@core/models/Error.ts';
import type {
  ExecutingSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  SendOperation,
} from '@core/operations/send/SendOperation.ts';
import { assertOutputProofs } from '@core/proofs/OutputProofs.ts';
import type { CoreProof } from '@core/types.ts';
import type {
  ApplySendResultInput,
  ExecuteExactSendInput,
  ExecuteExactSendResult,
} from './SendTransitionTypes.ts';

/** Completion can resume after an old finalizer released spent inputs before crashing. */
export function canCompleteWithInput(proof: CoreProof, operationId: string): boolean {
  return (
    proof.usedByOperationId === operationId ||
    (proof.usedByOperationId == null && proof.state === 'spent')
  );
}

export function getIdempotentExactResult(
  current: SendOperation | null,
  input: ExecuteExactSendInput,
): ExecuteExactSendResult | undefined {
  if (!current || current.state !== 'pending' || current.needsSwap || !current.token) {
    return undefined;
  }
  if (!isEquivalentExactToken(current, current.token, input)) {
    throw new SendOperationConflictError(
      input.operationId,
      'Exact Send result differs from the already committed operation',
    );
  }
  return {
    operation: current as ExecuteExactSendResult['operation'],
    token: current.token,
    changed: false,
  };
}

function isEquivalentExactToken(
  operation: PendingSendOperation,
  token: Token,
  input: ExecuteExactSendInput,
): boolean {
  return (
    token.mint === operation.mintUrl &&
    normalizeUnit(token.unit) === normalizeUnit(operation.unit) &&
    normalizeMemo(token.memo) === normalizeMemo(input.memo) &&
    token.proofs.length === operation.inputProofSecrets.length &&
    token.proofs.every((proof, index) => proof.secret === operation.inputProofSecrets[index])
  );
}

export function assertExactInputs(
  resolved: Proof[],
  operation: PreparedSendOperation | ExecutingSendOperation,
): void {
  if (
    !sumProofs(resolved).equals(operation.amount) ||
    !operation.inputAmount.equals(operation.amount) ||
    !operation.fee.isZero()
  ) {
    throw new ProofValidationError(`Send operation ${operation.id} is not an exact proof match`);
  }
}

export function normalizeMemo(memo: string | undefined): string | undefined {
  const trimmed = memo?.trim();
  return trimmed ? trimmed : undefined;
}

export function assertSwapResult(
  operation: ExecutingSendOperation | PendingSendOperation,
  input: ApplySendResultInput,
): void {
  assertOutputProofs({
    ...operation,
    outputData: operation.outputData!,
    createdByOperationId: operation.id,
    proofs: input.keepProofs,
    state: 'ready',
    kind: 'keep',
  });
  assertOutputProofs({
    ...operation,
    outputData: operation.outputData!,
    createdByOperationId: operation.id,
    proofs: input.sendProofs,
    state: 'inflight',
    kind: 'send',
  });

  if (
    input.token.mint !== operation.mintUrl ||
    normalizeUnit(input.token.unit) !== normalizeUnit(operation.unit) ||
    input.token.memo !== operation.executionMemo ||
    !sameProofSet(input.token.proofs, input.sendProofs)
  ) {
    throw new ProofValidationError('Swap token does not match the persisted Send request');
  }
}

export function sameToken(left: Token, right: Token): boolean {
  return (
    left.mint === right.mint &&
    normalizeUnit(left.unit) === normalizeUnit(right.unit) &&
    left.memo === right.memo &&
    sameProofSet(left.proofs, right.proofs)
  );
}

export function sameCoreProofSet(left: CoreProof[], right: CoreProof[]): boolean {
  return (
    sameProofSet(left, right) &&
    left.every((proof) => {
      const candidate = right.find((item) => item.secret === proof.secret);
      return (
        candidate?.mintUrl === proof.mintUrl &&
        normalizeUnit(candidate.unit) === normalizeUnit(proof.unit) &&
        candidate.createdByOperationId === proof.createdByOperationId
      );
    })
  );
}

export function sameProofSet(left: Proof[], right: Proof[]): boolean {
  if (
    left.length !== right.length ||
    new Set(left.map((proof) => proof.secret)).size !== left.length ||
    new Set(right.map((proof) => proof.secret)).size !== right.length
  ) {
    return false;
  }
  const rightBySecret = new Map(right.map((proof) => [proof.secret, proof]));
  return left.every((proof) => {
    const candidate = rightBySecret.get(proof.secret);
    return candidate ? sameProof(proof, candidate) : false;
  });
}

function sameProof(left: Proof, right: Proof): boolean {
  return (
    left.id === right.id &&
    left.secret === right.secret &&
    left.C === right.C &&
    Amount.from(left.amount).equals(Amount.from(right.amount)) &&
    left.witness === right.witness &&
    JSON.stringify(left.dleq) === JSON.stringify(right.dleq)
  );
}

// ============================================================================
// Intent Identity
// ============================================================================

/**
 * Identity-relevant fields of a send intent.
 *
 * Two operations that agree on these fields describe the same requested send, which lets a
 * caller-supplied operation ID be joined when the intent matches and reported as a conflict when it
 * does not.
 */
export type SendOperationIntent = Pick<
  PreparedSendOperation,
  'mintUrl' | 'amount' | 'unit' | 'method' | 'methodData'
>;

/** Compares two send intents, normalizing mint URL, unit, and method data. */
export function isSameSendIntent(a: SendOperationIntent, b: SendOperationIntent): boolean {
  return (
    normalizeMintUrl(a.mintUrl) === normalizeMintUrl(b.mintUrl) &&
    normalizeUnit(a.unit) === normalizeUnit(b.unit) &&
    a.amount.equals(b.amount) &&
    a.method === b.method &&
    canonicalMethodData(a.methodData) === canonicalMethodData(b.methodData)
  );
}

/**
 * Stable string form of method data so key order and `undefined` placeholders alone do not read as
 * a different intent. Repositories persist method data as JSON, which drops those placeholders.
 */
function canonicalMethodData(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalMethodData).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalMethodData(entry)}`)
      .join(',')}}`;
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}
