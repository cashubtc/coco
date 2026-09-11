import { isBlsKeyset } from '@cashu/cashu-ts';
import type { Mint } from '@core/models/Mint.ts';
import type { Keyset } from '@core/models/Keyset.ts';
import type { MintInfo } from '@core/types.ts';
import { normalizeMintUrl } from '@core/utils.ts';

export const MINT_REFRESH_TTL_S = 60 * 5;

export interface MintMetadata {
  mint: Mint;
  keysets: Keyset[];
}

export interface MintMetadataObservation {
  mintUrl: string;
  mintInfo: MintInfo;
  keysets: Omit<Keyset, 'updatedAt'>[];
  observedAt: number;
}

/** The authoritative snapshot and whether this observation changed it. */
export interface MintMetadataApplyResult {
  metadata: MintMetadata;
  applied: boolean;
}

export interface MintQueries {
  getMetadata(mintUrl: string): Promise<MintMetadata | null>;
}

/** Composes read-only interfaces; fetching a snapshot never refreshes or repairs storage. */
export class StoredMintQueries implements MintQueries {
  constructor(
    private readonly mints: {
      getAllMints(): Promise<Mint[]>;
    },
    private readonly keysets: { getKeysetsByMintUrl(mintUrl: string): Promise<Keyset[]> },
  ) {}

  async getMetadata(mintUrl: string): Promise<MintMetadata | null> {
    mintUrl = normalizeMintUrl(mintUrl);
    const mint = (await this.mints.getAllMints()).find((item) => item.mintUrl === mintUrl);
    if (!mint) return null;
    const keysets = await this.keysets.getKeysetsByMintUrl(mintUrl);
    return { mint, keysets: keysets.filter((keyset) => !isBlsKeyset(keyset.id)) };
  }
}
