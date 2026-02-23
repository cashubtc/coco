import type { Mint, Proof } from '@cashu/cashu-ts';

export type MintInfo = Awaited<ReturnType<Mint['getInfo']>>;

export type ProofState = 'inflight' | 'ready' | 'spent';

export interface CoreProof extends Proof {
  mintUrl: string;
  state: ProofState;

  /**
   * ID of the operation that is using this proof as input.
   * When set, the proof is reserved and should not be used by other operations.
   */
  usedByOperationId?: string;

  /**
   * ID of the operation that created this proof as output.
   * Used for auditing and rollback purposes.
   */
  createdByOperationId?: string;
}

// --- Blind Auth (non-standard cdk extension) ---

/** Wire format for AuthProof — subset of Proof without amount/witness. */
export interface AuthProof {
  id: string;
  secret: string;
  C: string;
  dleq?: { e: string; s: string; r: string };
}

export interface CheckBlindAuthStateRequest {
  auth_proofs: AuthProof[];
}

/** NUT-07 ProofState wire format (reused by auth/blind endpoints). */
export interface BlindAuthProofState {
  Y: string;
  state: 'SPENT' | 'UNSPENT' | 'PENDING';
  witness?: string;
}

export interface CheckBlindAuthStateResponse {
  states: BlindAuthProofState[];
}

export interface SpendBlindAuthRequest {
  auth_proof: AuthProof;
}

export interface SpendBlindAuthResponse {
  state: BlindAuthProofState;
}

/** Strip amount/witness from a BAT Proof to produce the cdk AuthProof wire format. */
export function toAuthProof(proof: Proof): AuthProof {
  const ap: AuthProof = { id: proof.id, secret: proof.secret, C: proof.C };
  if (proof.dleq) ap.dleq = { e: proof.dleq.e, s: proof.dleq.s, r: proof.dleq.r };
  return ap;
}
