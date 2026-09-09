import type { Mint } from '../models/Mint.ts';
import type { Keyset } from '../models/Keyset.ts';

/** Read-only Known Mint state; adapters implement these queries directly. */
export interface MintQueries {
  getAllMints(): Promise<Mint[]>;
  getAllTrustedMints(): Promise<Mint[]>;
  isTrustedMint(mintUrl: string): Promise<boolean>;
}

export interface KeysetQueries {
  getKeysetsByMintUrl(mintUrl: string): Promise<Keyset[]>;
  getKeysetById(mintUrl: string, id: string): Promise<Keyset | null>;
}
