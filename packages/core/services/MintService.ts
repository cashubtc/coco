import { CashuMint } from "@cashu/cashu-ts";
import {
  KeysetSyncError,
  MintFetchError,
  UnknownMintError,
} from "../models/Error";
import type { Mint } from "../models/Mint";
import type { Keyset } from "../models/Keyset";

const MINT_REFRESH_TTL_S = 60 * 5;

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

export class MintService {
  private readonly mintRepo: MintRepository;
  private readonly keysetRepo: KeysetRepository;

  constructor(mintRepo: MintRepository, keysetRepo: KeysetRepository) {
    this.mintRepo = mintRepo;
    this.keysetRepo = keysetRepo;
  }

  private async ensureUpdatedMint(mintUrl: string): Promise<Mint> {
    const isKnownMint = await this.mintRepo.isKnownMint(mintUrl);
    if (!isKnownMint) {
      throw new UnknownMintError(`Mint ${mintUrl} is not known`);
    }

    const mint = await this.mintRepo.getMintByUrl(mintUrl);
    const now = Math.floor(Date.now() / 1000);
    if (mint.updatedAt < now - MINT_REFRESH_TTL_S) {
      return await this.updateMint(mint);
    }

    return mint;
  }

  private async updateMint(mint: Mint): Promise<Mint> {
    const cashuMint = new CashuMint(mint.mintUrl);
    let mintInfo;
    try {
      mintInfo = await cashuMint.getInfo();
    } catch (err) {
      throw new MintFetchError(mint.mintUrl, undefined, err);
    }

    let keysets;
    try {
      ({ keysets } = await cashuMint.getKeySets());
    } catch (err) {
      throw new MintFetchError(mint.mintUrl, "Failed to fetch keysets", err);
    }
    await Promise.all(
      keysets.map(async (ks) => {
        const existingKeyset = await this.keysetRepo.getKeysetById(
          mint.mintUrl,
          ks.id
        );
        if (existingKeyset) {
          const keysetModel: Omit<Keyset, "keypairs" | "updatedAt"> = {
            mintUrl: mint.mintUrl,
            id: ks.id,
            active: ks.active,
            feePpk: ks.input_fee_ppk || 0,
          };
          return this.keysetRepo.updateKeyset(keysetModel);
        } else {
          try {
            const keysRes = await cashuMint.getKeys(ks.id);
            if (keysRes.keysets.length !== 1 || !keysRes.keysets[0]) {
              throw new Error(
                `Expected 1 keyset for ${ks.id}, got ${keysRes.keysets.length}`
              );
            }
            const keypairs = Object.fromEntries(
              Object.entries(keysRes.keysets[0].keys).map(([k, v]) => [
                Number(k),
                v,
              ])
            ) as Record<number, string>;
            return this.keysetRepo.addKeyset({
              mintUrl: mint.mintUrl,
              id: ks.id,
              keypairs,
              active: ks.active,
              feePpk: ks.input_fee_ppk || 0,
            });
          } catch (err) {
            throw new KeysetSyncError(mint.mintUrl, ks.id, undefined, err);
          }
        }
      })
    );

    // Persist mint updates only after successful fetch and keyset sync
    mint.mintInfo = mintInfo;
    mint.updatedAt = Math.floor(Date.now() / 1000);
    await this.mintRepo.updateMint(mint);

    return mint;
  }
}
