import { getOutputKeysetId } from '@core/proofs/OutputProofs.ts';
import type { MintMetadata, MintMetadataObservation } from '@core/mints/MintMetadata.ts';
import type { Keyset } from '@core/models/Keyset.ts';
import type { SendRemote, SendRemoteSession } from '@core/operations/send/SendRemote.ts';
import { deserializeOutputData } from '@core/utils.ts';
import type { CashuMintClient } from '../../CashuMintClient.ts';
import { restoreOutputProofs } from '../../ProofRestore.ts';

/** Send protocol effects over the shared mint client, without persistence authority. */
export class CashuSendRemote implements SendRemote {
  constructor(private readonly client: CashuMintClient) {}

  fetchMintMetadata(
    mintUrl: string,
    knownKeysets: readonly Keyset[],
  ): Promise<MintMetadataObservation> {
    return this.client.fetchMintMetadata(mintUrl, knownKeysets);
  }

  open(metadata: MintMetadata, unit: string): SendRemoteSession {
    const mintUrl = metadata.mint.mintUrl;
    const wallet = this.client.openWallet(metadata, unit);
    return {
      swap: (request) => {
        const data = deserializeOutputData(request.outputData);
        const keysetId = getOutputKeysetId([...data.keep, ...data.send]);
        return wallet.send(
          request.amount,
          request.inputProofs,
          { keysetId },
          {
            send: { type: 'custom', data: data.send },
            keep: { type: 'custom', data: data.keep },
          },
        );
      },
      checkProofStates: (proofs) => wallet.checkProofsStates(proofs),
      restoreOutputs: (outputs) => restoreOutputProofs(wallet, metadata.keysets, unit, outputs),
      reclaim: (proofs, outputs) => {
        const data = deserializeOutputData(outputs).keep;
        const keysetId = getOutputKeysetId(data);
        return wallet.receive(
          { mint: mintUrl, proofs, unit },
          { keysetId },
          {
            type: 'custom',
            data,
          },
        );
      },
    };
  }
}
