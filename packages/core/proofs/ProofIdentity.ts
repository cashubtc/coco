import { Amount, type Proof } from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import type { CoreProof } from '@core/types.ts';

/** Immutable proof identity, independent of later spend state and reservation metadata. */
export function sameProof(left: Proof, right: Proof): boolean {
  return (
    left.id === right.id &&
    left.secret === right.secret &&
    left.C === right.C &&
    Amount.from(left.amount).equals(Amount.from(right.amount)) &&
    left.witness === right.witness &&
    JSON.stringify(left.dleq) === JSON.stringify(right.dleq)
  );
}

export function sameCoreProof(left: CoreProof, right: CoreProof): boolean {
  return (
    sameProof(left, right) &&
    left.mintUrl === right.mintUrl &&
    normalizeUnit(left.unit) === normalizeUnit(right.unit) &&
    left.createdByOperationId === right.createdByOperationId
  );
}

export function sameProofSet(left: readonly Proof[], right: readonly Proof[]): boolean {
  if (
    left.length !== right.length ||
    new Set(left.map((proof) => proof.secret)).size !== left.length ||
    new Set(right.map((proof) => proof.secret)).size !== right.length
  )
    return false;
  const bySecret = new Map(right.map((proof) => [proof.secret, proof]));
  return left.every((proof) => {
    const candidate = bySecret.get(proof.secret);
    return candidate ? sameProof(proof, candidate) : false;
  });
}

export function sameCoreProofSet(left: readonly CoreProof[], right: readonly CoreProof[]): boolean {
  if (!sameProofSet(left, right)) return false;
  const bySecret = new Map(right.map((proof) => [proof.secret, proof]));
  return left.every((proof) => sameCoreProof(proof, bySecret.get(proof.secret)!));
}
