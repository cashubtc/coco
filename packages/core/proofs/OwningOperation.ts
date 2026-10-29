import type { CoreProof } from '@core/types.ts';

type OperationReferences = Pick<CoreProof, 'usedByOperationId' | 'createdByOperationId'>;

/**
 * The id of a proof record's Owning Operation: the operation that reserved it, else the one that
 * created it. A proof with neither reference is unowned.
 */
export function getOwningOperationId(proof: OperationReferences): string | undefined {
  return proof.usedByOperationId ?? proof.createdByOperationId ?? undefined;
}

export function isUnownedProof(proof: OperationReferences): boolean {
  return getOwningOperationId(proof) === undefined;
}
