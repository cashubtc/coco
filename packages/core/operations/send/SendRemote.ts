import type { Proof, ProofState } from '@cashu/cashu-ts';
import type { MintMetadata } from '@core/mints/MintMetadata.ts';
import type { SerializedOutputData } from '@core/utils.ts';
import type { SwapTransportRequest } from '@core/transactions/send/types.ts';

/** A mint-and-unit-scoped protocol client. It has no Wallet persistence authority. */
export interface SendRemoteSession {
  swap(request: SwapTransportRequest): Promise<{ keep: Proof[]; send: Proof[] }>;
  checkProofStates(proofs: Proof[]): Promise<ProofState[]>;
  restoreOutputs(outputData: SerializedOutputData): Promise<Proof[]>;
  reclaim(proofs: Proof[], outputData: SerializedOutputData): Promise<Proof[]>;
}

export interface SendRemote {
  open(metadata: MintMetadata, unit: string): SendRemoteSession;
}
