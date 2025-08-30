import type { Proof } from '@cashu/cashu-ts';
import type { CoreProof, ProofState } from './types';

export function mapProofToCoreProof(
  mintUrl: string,
  state: ProofState,
  proofs: Proof[],
): CoreProof[] {
  return proofs.map((p) => ({
    ...p,
    mintUrl,
    state,
  }));
}
