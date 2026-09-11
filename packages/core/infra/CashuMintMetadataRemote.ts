import { isBlsKeyset } from '@cashu/cashu-ts';
import type { MintMetadataObservation } from '@core/mints/MintMetadata.ts';
import type { MintMetadataRemote } from '@core/mints/MintMetadataRemote.ts';
import type { Keyset } from '@core/models/Keyset.ts';
import { KeysetSyncError, MintFetchError } from '@core/models/Error.ts';
import type { MintAdapter } from './MintAdapter.ts';

/** Shared mint metadata transport with no persistence authority. */
export class CashuMintMetadataRemote implements MintMetadataRemote {
  constructor(
    private readonly mint: Pick<MintAdapter, 'fetchMintInfo' | 'fetchKeysets' | 'fetchKeysForId'>,
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
}
