import type { Mint } from "../models/Mint";
import type { Keyset } from "../models/Keyset";

export interface MintRepository {
  isKnownMint(mintUrl: string): Promise<boolean>;
  getMintByUrl(mintUrl: string): Promise<Mint>;
  getAllMints(): Promise<Mint[]>;
  addNewMint(mint: Mint): Promise<void>;
  updateMint(mint: Mint): Promise<void>;
  deleteMint(mintUrl: string): Promise<void>;
}

export interface KeysetRepository {
  getKeysetsByMintUrl(mintUrl: string): Promise<Keyset[]>;
  getKeysetById(mintUrl: string, id: string): Promise<Keyset | null>;
  updateKeyset(keyset: Omit<Keyset, "keypairs" | "updatedAt">): Promise<void>;
  addKeyset(keyset: Omit<Keyset, "updatedAt">): Promise<void>;
  deleteKeyset(mintUrl: string, keysetId: string): Promise<void>;
}
