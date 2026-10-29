import { normalizeMintUrl } from '../../utils.ts';
import { defineTransition } from '../../transactions/Transition.ts';

/**
 * Reconcile fresh SPENT evidence for inflight proofs that no operation owns. Ownership and state are
 * rechecked in the caller's scope, so a proof reserved or changed after observation stays untouched.
 * Proofs with an Owning Operation change only through that operation.
 */
export const recordUnownedProofsSpent = defineTransition(
  async (tx, input: { mintUrl: string; secrets: string[] }) => {
    const mintUrl = normalizeMintUrl(input.mintUrl);
    const spentSecrets = await tx.proofs.recordUnownedSpent(mintUrl, input.secrets);
    return { mintUrl, spentSecrets };
  },
);
