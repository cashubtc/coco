import { normalizeUnit } from '../amounts.ts';
import { ProofValidationError } from '../models/Error.ts';
import type { RestoredProofObservation } from '../proofs/RestoredProofs.ts';
import { defineTransition } from '../transactions/Transition.ts';
import { normalizeMintUrl } from '../utils.ts';

export interface ApplyRestoredKeysetInput {
  mintUrl: string;
  keysetId: string;
  unit: string;
  observations: readonly RestoredProofObservation[];
  lastCounterWithSignature: number | null | undefined;
}

/** Import one keyset and protect all observed output positions in the caller's transaction. */
export const applyRestoredKeyset = defineTransition(async (tx, input: ApplyRestoredKeysetInput) => {
  const mintUrl = normalizeMintUrl(input.mintUrl);
  const unit = normalizeUnit(input.unit);
  const last = input.lastCounterWithSignature;
  if (
    last != null &&
    (!Number.isSafeInteger(last) || last < 0 || !Number.isSafeInteger(last + 1))
  ) {
    throw new ProofValidationError('Invalid restored counter');
  }
  const counter = await tx.outputs.advanceCounterToAtLeast(
    mintUrl,
    input.keysetId,
    last == null ? 0 : last + 1,
  );
  const proofs = await tx.proofs.reconcileRestored({ ...input, mintUrl, unit });
  return { counter, proofs };
});
