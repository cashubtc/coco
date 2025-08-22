import {
  KeysetSyncError,
  MintFetchError,
  UnknownMintError,
} from "../models/Error";
import type { Mint } from "../models/Mint";
import type { Keyset } from "../models/Keyset";
import { MintAdapter } from "../infra/MintAdapter";
import type { KeysetRepository, MintRepository } from "../repositories";
import { EventBus } from "../events/EventBus";
import type { CoreEvents } from "../events/types";
import type { MintInfo } from "../types";

const MINT_REFRESH_TTL_S = 60 * 5;

export class MintService {
  private readonly mintRepo: MintRepository;
  private readonly keysetRepo: KeysetRepository;
  private readonly mintAdapter: MintAdapter;
  private readonly eventBus?: EventBus<CoreEvents>;

  constructor(
    mintRepo: MintRepository,
    keysetRepo: KeysetRepository,
    eventBus?: EventBus<CoreEvents>
  ) {
    this.mintRepo = mintRepo;
    this.keysetRepo = keysetRepo;
    this.mintAdapter = new MintAdapter();
    this.eventBus = eventBus;
  }

  /**
   * Add a new mint by URL, running a single update cycle to fetch info & keysets.
   * If the mint already exists, it ensures it is updated.
   */
  async addMintByUrl(
    mintUrl: string
  ): Promise<{ mint: Mint; keysets: Keyset[] }> {
    const exists = await this.mintRepo.isKnownMint(mintUrl);
    if (exists) return this.ensureUpdatedMint(mintUrl);

    const now = Math.floor(Date.now() / 1000);
    const newMint: Mint = {
      mintUrl,
      name: mintUrl,
      mintInfo: {} as MintInfo,
      createdAt: now,
      updatedAt: 0,
    };
    // Do not persist before successful sync; updateMint will persist on success
    const added = await this.updateMint(newMint);
    await this.eventBus?.emit("mint:added", added);
    return added;
  }

  async updateMintData(
    mintUrl: string
  ): Promise<{ mint: Mint; keysets: Keyset[] }> {
    const isKnownMint = await this.mintRepo.isKnownMint(mintUrl);
    if (!isKnownMint) {
      throw new UnknownMintError(`Mint ${mintUrl} is not known`);
    }
    const mint = await this.mintRepo.getMintByUrl(mintUrl);
    return this.updateMint(mint);
  }

  async isKnownMint(mintUrl: string): Promise<boolean> {
    return await this.mintRepo.isKnownMint(mintUrl);
  }

  async ensureUpdatedMint(
    mintUrl: string
  ): Promise<{ mint: Mint; keysets: Keyset[] }> {
    const isKnownMint = await this.mintRepo.isKnownMint(mintUrl);
    if (!isKnownMint) {
      throw new UnknownMintError(`Mint ${mintUrl} is not known`);
    }

    const mint = await this.mintRepo.getMintByUrl(mintUrl);
    const now = Math.floor(Date.now() / 1000);
    if (mint.updatedAt < now - MINT_REFRESH_TTL_S) {
      const updated = await this.updateMint(mint);
      await this.eventBus?.emit("mint:updated", updated);
      return updated;
    }

    const keysets = await this.keysetRepo.getKeysetsByMintUrl(mint.mintUrl);
    return { mint, keysets };
  }

  private async updateMint(
    mint: Mint
  ): Promise<{ mint: Mint; keysets: Keyset[] }> {
    let mintInfo;
    try {
      mintInfo = await this.mintAdapter.fetchMintInfo(mint.mintUrl);
    } catch (err) {
      throw new MintFetchError(mint.mintUrl, undefined, err);
    }

    let keysets;
    try {
      ({ keysets } = await this.mintAdapter.fetchKeysets(mint.mintUrl));
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
            const keysRes = await this.mintAdapter.fetchKeysForId(
              mint.mintUrl,
              ks.id
            );
            const keypairs = Object.fromEntries(
              Object.entries(keysRes).map(([k, v]) => [Number(k), v])
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

    const repoKeysets = await this.keysetRepo.getKeysetsByMintUrl(mint.mintUrl);
    return { mint, keysets: repoKeysets };
  }
}
