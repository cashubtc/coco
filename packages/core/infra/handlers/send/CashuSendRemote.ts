import {
  isBlsKeyset,
  Mint,
  Wallet,
  type OutputDataCreator,
  type OutputDataLike,
} from '@cashu/cashu-ts';
import type { MintMetadata, MintMetadataObservation } from '@core/mints/MintMetadata.ts';
import type { Keyset } from '@core/models/Keyset.ts';
import { KeysetSyncError, MintFetchError, ProofValidationError } from '@core/models/Error.ts';
import type { SendRemote, SendRemoteSession } from '@core/operations/send/SendRemote.ts';
import { createKeyChain } from '@core/proofs/KeysetSelection.ts';
import { deserializeOutputData } from '@core/utils.ts';
import type { MintAdapter } from '../../MintAdapter.ts';
import type { MintRequestProvider } from '../../MintRequestProvider.ts';
import { restoreOutputProofs } from '../../ProofRestore.ts';

/** Protocol effects and unblinding. No Services, repositories, transactions, or event publisher. */
export class CashuSendRemote implements SendRemote {
  constructor(
    private readonly mint: Pick<
      MintAdapter,
      'fetchMintInfo' | 'fetchKeysets' | 'fetchKeysForId' | 'getAuthProvider'
    >,
    private readonly requests: Pick<MintRequestProvider, 'getRequestFn'>,
    private readonly outputDataCreator?: OutputDataCreator,
  ) {}

  async fetchMintMetadata(
    mintUrl: string,
    knownKeysets: readonly Keyset[],
  ): Promise<MintMetadataObservation> {
    const observedAt = Math.floor(Date.now() / 1000);
    const mintInfo = await this.mint.fetchMintInfo(mintUrl).catch((error: unknown) => {
      throw new MintFetchError(mintUrl, undefined, error);
    });
    const result = await this.mint.fetchKeysets(mintUrl).catch((error: unknown) => {
      throw new MintFetchError(mintUrl, 'Failed to fetch keysets', error);
    });
    const keysets = await Promise.all(
      result.keysets
        .filter((keyset) => !isBlsKeyset(keyset.id))
        .map(async (keyset) => {
          const known = knownKeysets.find((candidate) => candidate.id === keyset.id);
          const keypairs =
            known?.keypairs ??
            (await this.mint.fetchKeysForId(mintUrl, keyset.id).catch((error: unknown) => {
              throw new KeysetSyncError(mintUrl, keyset.id, undefined, error);
            }));
          return {
            mintUrl,
            id: keyset.id,
            unit: keyset.unit,
            active: keyset.active,
            feePpk: keyset.input_fee_ppk || 0,
            keypairs,
          };
        }),
    );
    return { mintUrl, mintInfo, keysets, observedAt };
  }

  open(metadata: MintMetadata, unit: string): SendRemoteSession {
    const mintUrl = metadata.mint.mintUrl;
    const wallet = new Wallet(
      new Mint(mintUrl, {
        customRequest: this.requests.getRequestFn(mintUrl),
        authProvider: this.mint.getAuthProvider(mintUrl),
      }),
      { unit, outputDataCreator: this.outputDataCreator },
    );
    wallet.loadMintFromCache(
      metadata.mint.mintInfo,
      createKeyChain(mintUrl, unit, metadata.keysets).cache,
    );
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

/** Pin unblinding to the committed output plan, even if the wallet now prefers another keyset. */
function getOutputKeysetId(outputs: readonly OutputDataLike[]): string {
  const keysetId = outputs[0]?.blindedMessage.id;
  if (!keysetId || outputs.some((output) => output.blindedMessage.id !== keysetId)) {
    throw new ProofValidationError('Send outputs must specify a single non-empty keyset id');
  }
  return keysetId;
}
