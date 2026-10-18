import type { CoreProof } from '../../types.ts';
import { normalizeMintUrl } from '../../utils.ts';
import { ProofValidationError } from '../../models/Error.ts';
import { defineTransition } from '../../transactions/Transition.ts';

/** Import an already-issued keyset result and its high-water mark in one caller-owned scope. */
export const applyRestoreResult = defineTransition(
  async (
    tx,
    input: {
      mintUrl: string;
      keysetId: string;
      proofs: CoreProof[];
      nextCounter: number;
    },
  ) => {
    const mintUrl = normalizeMintUrl(input.mintUrl);
    if (input.proofs.some((proof) => proof.id !== input.keysetId)) {
      throw new ProofValidationError('Restored proof belongs to a different keyset');
    }
    const changes = await tx.proofs.importRestored(mintUrl, input.proofs);
    const counter = await tx.outputs.advanceCounterToAtLeast(
      mintUrl,
      input.keysetId,
      input.nextCounter,
    );
    return { ...changes, counter };
  },
);
