import type { Proof, ProofState } from '@cashu/cashu-ts';
import type { MintMetadata, MintMetadataObservation } from '@core/mints/MintMetadata.ts';
import type { Keyset } from '@core/models/Keyset.ts';
import type { RestoreProofsObservation } from '@core/proofs/RestoreProofsObservation.ts';
import type { SerializedOutputData } from '@core/utils.ts';
import type { ReceiveTransportRequest } from '@core/transactions/receive/types.ts';

/** Mint-and-unit-scoped effects, with no Wallet persistence or key-management authority. */
export interface ReceiveRemoteSession {
  receive(request: ReceiveTransportRequest): Promise<Proof[]>;
  checkProofStates(proofs: Proof[]): Promise<ProofState[]>;
  observeRestore(outputData: SerializedOutputData): Promise<RestoreProofsObservation>;
}

export interface ReceiveRemote {
  fetchMintMetadata(
    mintUrl: string,
    knownKeysets: readonly Keyset[],
  ): Promise<MintMetadataObservation>;
  open(metadata: MintMetadata, unit: string): ReceiveRemoteSession;
}
