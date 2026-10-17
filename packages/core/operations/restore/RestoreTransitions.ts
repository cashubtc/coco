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

/** Re-read state and ownership before applying a fresh mint observation. */
export const reconcileRestoredPending = defineTransition(
  async (
    tx,
    input: {
      mintUrl: string;
      secret: string;
      state: 'UNSPENT' | 'PENDING' | 'SPENT';
    },
  ) =>
    tx.proofs.reconcilePending(
      input.mintUrl,
      input.secret,
      input.state === 'UNSPENT' ? 'ready' : input.state === 'SPENT' ? 'spent' : 'pending',
    ),
);
