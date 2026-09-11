import type { Keyset } from '@core/models/Keyset.ts';
import type { MintMetadataObservation } from './MintMetadata.ts';

/** Remote observation only; no Wallet persistence authority. */
export interface MintMetadataRemote {
  fetchMintMetadata(
    mintUrl: string,
    knownKeysets: readonly Keyset[],
  ): Promise<MintMetadataObservation>;
}
