import { Amount, type Proof, type ProofState } from '@cashu/cashu-ts';
import { ProofValidationError } from '../models/Error.ts';

export interface RestoredProofObservation {
  proof: Proof;
  state: 'UNSPENT' | 'PENDING' | 'SPENT';
}

/** cashu-ts aligns states with the requested proofs. Only explicit UNSPENT is eligible. */
export function observeRestoredProofs(
  keysetId: string,
  proofs: readonly Proof[],
  states: readonly ProofState[],
): RestoredProofObservation[] {
  if (!Array.isArray(states) || states.length !== proofs.length) {
    throw new ProofValidationError('Malformed state check');
  }
  const observations: RestoredProofObservation[] = [];
  const secrets = new Set<string>();
  for (let index = 0; index < proofs.length; index++) {
    const proof = proofs[index];
    const state = states[index]?.state;
    if (state !== 'UNSPENT' && state !== 'PENDING' && state !== 'SPENT') {
      throw new ProofValidationError('Malformed state check');
    }
    if (
      !proof ||
      proof.id !== keysetId ||
      typeof proof.secret !== 'string' ||
      !proof.secret ||
      typeof proof.C !== 'string' ||
      !proof.C ||
      secrets.has(proof.secret)
    ) {
      throw new ProofValidationError('Invalid restored proof');
    }
    const amount = Amount.from(proof.amount);
    if (amount.isZero()) throw new ProofValidationError('Invalid restored proof amount');
    secrets.add(proof.secret);
    observations.push({
      state,
      proof: {
        id: proof.id,
        secret: proof.secret,
        C: proof.C,
        amount,
        ...(proof.dleq ? { dleq: { ...proof.dleq } } : {}),
        ...(proof.witness ? { witness: proof.witness } : {}),
      },
    });
  }
  return observations;
}
