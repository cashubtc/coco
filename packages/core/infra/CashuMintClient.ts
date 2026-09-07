import { isBlsKeyset, Mint, Wallet, type OutputDataCreator } from '@cashu/cashu-ts';
import type { MintMetadata, MintMetadataObservation } from '@core/mints/MintMetadata.ts';
import type { Keyset } from '@core/models/Keyset.ts';
import { KeysetSyncError, MintFetchError } from '@core/models/Error.ts';
import { createKeyChain } from '@core/proofs/KeysetSelection.ts';
import type { MintAdapter } from './MintAdapter.ts';
import type { MintRequestProvider } from './MintRequestProvider.ts';

/** Protocol effects and unblinding. No Services, repositories, transactions, or event publisher. */
export class CashuMintClient {
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

  openWallet(metadata: MintMetadata, unit: string): Wallet {
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
    return wallet;
  }
}
