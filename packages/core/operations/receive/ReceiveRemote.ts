import type { Proof, ProofState } from '@cashu/cashu-ts';
import type { MintMetadata } from '@core/mints/MintMetadata.ts';
import type { SerializedOutputData } from '@core/utils.ts';

export interface ReceiveRequest {
  mintUrl: string;
  unit: string;
  inputProofs: Proof[];
  outputData: SerializedOutputData;
}

export interface ReceiveRemoteSession {
  receive(request: ReceiveRequest): Promise<Proof[]>;
  /** Complete, identity-checked states in input order. Invalid responses reject. */
  checkProofStates(proofs: readonly Proof[]): Promise<ProofState[]>;
  /** Returns every issued output, including spent outputs. Missing signatures are not errors. */
  restoreOutputs(outputData: SerializedOutputData): Promise<Proof[]>;
}

export interface ReceiveRemote {
  open(metadata: MintMetadata, unit: string): ReceiveRemoteSession;
}
