import { getOutputKeysetId } from '@core/proofs/OutputProofs.ts';
import type { MintMetadata, MintMetadataObservation } from '@core/mints/MintMetadata.ts';
import type { Keyset } from '@core/models/Keyset.ts';
import type {
  ReceiveRemote,
  ReceiveRemoteSession,
} from '@core/operations/receive/ReceiveRemote.ts';
import { deserializeOutputData } from '@core/utils.ts';
import type { CashuMintClient } from '../../CashuMintClient.ts';
import { observeOutputProofs } from '../../ProofRestore.ts';

export class CashuReceiveRemote implements ReceiveRemote {
  constructor(private readonly client: CashuMintClient) {}

  fetchMintMetadata(
    mintUrl: string,
    knownKeysets: readonly Keyset[],
  ): Promise<MintMetadataObservation> {
    return this.client.fetchMintMetadata(mintUrl, knownKeysets);
  }

  open(metadata: MintMetadata, unit: string): ReceiveRemoteSession {
    const wallet = this.client.openWallet(metadata, unit);
    return {
      receive: (request) => {
        const data = deserializeOutputData(request.outputData).keep;
        return wallet.receive(
          { mint: request.mintUrl, proofs: request.inputProofs, unit: request.unit },
          { keysetId: getOutputKeysetId(data) },
          { type: 'custom', data },
        );
      },
      checkProofStates: async (proofs) => {
        const states = [];
        // Preserve Receive's existing request limit independently of cashu-ts defaults.
        for (let offset = 0; offset < proofs.length; offset += 100) {
          states.push(...(await wallet.checkProofsStates(proofs.slice(offset, offset + 100))));
        }
        return states;
      },
      observeRestore: (outputs) => observeOutputProofs(wallet, metadata.keysets, unit, outputs),
    };
  }
}
