import { KeysetSyncError, MintFetchError, UnknownMintError } from '../models/Error';
import type { Mint } from '../models/Mint';
import type { Keyset } from '../models/Keyset';
import { MintAdapter } from '../infra/MintAdapter';
import type { KeysetRepository, MintRepository } from '../repositories';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { MintInfo } from '../types';
import type { Logger } from '../logging/Logger.ts';

const MINT_REFRESH_TTL_S = 60 * 5;

export class MintService {
  private readonly mintRepo: MintRepository;
  private readonly keysetRepo: KeysetRepository;
  private readonly mintAdapter: MintAdapter;
  private readonly eventBus?: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  constructor(
    mintRepo: MintRepository,
    keysetRepo: KeysetRepository,
    logger?: Logger,
    eventBus?: EventBus<CoreEvents>,
  ) {
    this.mintRepo = mintRepo;
    this.keysetRepo = keysetRepo;
    this.mintAdapter = new MintAdapter();
    this.logger = logger;
    this.eventBus = eventBus;
  }

  /**
   * Add a new mint by URL, running a single update cycle to fetch info & keysets.
   * If the mint already exists, it ensures it is updated.
   * New mints are added as untrusted by default unless explicitly specified.
   *
   * @param mintUrl - The URL of the mint to add
   * @param options - Optional configuration
   * @param options.trusted - Whether to add the mint as trusted (default: false)
   */
  async addMintByUrl(
    mintUrl: string,
    options?: { trusted?: boolean },
  ): Promise<{ mint: Mint; keysets: Keyset[] }> {
    const trusted = options?.trusted ?? false;
    this.logger?.info('Adding mint by URL', { mintUrl, trusted });
    const exists = await this.mintRepo.getMintByUrl(mintUrl).catch(() => null);

    if (exists) {
      // If trusted option was explicitly provided and differs from current state, update it
      if (options?.trusted !== undefined && exists.trusted !== options.trusted) {
        await this.mintRepo.setMintTrusted(mintUrl, options.trusted);
        this.logger?.info('Updated mint trust status', { mintUrl, trusted: options.trusted });
      }
      return this.ensureUpdatedMint(mintUrl);
    }

    const now = Math.floor(Date.now() / 1000);
    const newMint: Mint = {
      mintUrl,
      name: mintUrl,
      mintInfo: {} as MintInfo,
      trusted,
      createdAt: now,
      updatedAt: 0,
    };
    // Do not persist before successful sync; updateMint will persist on success
    const added = await this.updateMint(newMint);
    await this.eventBus?.emit('mint:added', added);
    this.logger?.info('Mint added', { mintUrl, trusted });
    return added;
  }

  async updateMintData(mintUrl: string): Promise<{ mint: Mint; keysets: Keyset[] }> {
    const mint = await this.mintRepo.getMintByUrl(mintUrl).catch(() => null);
    if (!mint) {
      // Mint doesn't exist, create it as untrusted
      const now = Math.floor(Date.now() / 1000);
      const newMint: Mint = {
        mintUrl,
        name: mintUrl,
        mintInfo: {} as MintInfo,
        trusted: false,
        createdAt: now,
        updatedAt: 0,
      };
      return this.updateMint(newMint);
    }
    return this.updateMint(mint);
  }

  async isTrustedMint(mintUrl: string): Promise<boolean> {
    return await this.mintRepo.isTrustedMint(mintUrl);
  }

  async ensureUpdatedMint(mintUrl: string): Promise<{ mint: Mint; keysets: Keyset[] }> {
    let mint = await this.mintRepo.getMintByUrl(mintUrl).catch(() => null);

    if (!mint) {
      // Mint doesn't exist, create it as untrusted
      const now = Math.floor(Date.now() / 1000);
      mint = {
        mintUrl,
        name: mintUrl,
        mintInfo: {} as MintInfo,
        trusted: false,
        createdAt: now,
        updatedAt: 0,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (mint.updatedAt < now - MINT_REFRESH_TTL_S) {
      this.logger?.debug('Refreshing stale mint', { mintUrl });
      const updated = await this.updateMint(mint);
      await this.eventBus?.emit('mint:updated', updated);
      return updated;
    }

    const keysets = await this.keysetRepo.getKeysetsByMintUrl(mint.mintUrl);
    return { mint, keysets };
  }

  async deleteMint(mintUrl: string): Promise<void> {
    const mint = await this.mintRepo.getMintByUrl(mintUrl).catch(() => null);
    if (!mint) return;

    const keysets = await this.keysetRepo.getKeysetsByMintUrl(mintUrl);
    await Promise.all(keysets.map((ks) => this.keysetRepo.deleteKeyset(mintUrl, ks.id)));
    await this.mintRepo.deleteMint(mintUrl);
  }

  async getMintInfo(mintUrl: string): Promise<MintInfo> {
    const { mint } = await this.ensureUpdatedMint(mintUrl);
    return mint.mintInfo;
  }

  async getAllMints(): Promise<Mint[]> {
    const mints = await this.mintRepo.getAllMints();
    return mints;
  }

  async getAllTrustedMints(): Promise<Mint[]> {
    const mints = await this.mintRepo.getAllTrustedMints();
    return mints;
  }

  async trustMint(mintUrl: string): Promise<void> {
    this.logger?.info('Trusting mint', { mintUrl });
    await this.mintRepo.setMintTrusted(mintUrl, true);
    await this.eventBus?.emit('mint:updated', await this.ensureUpdatedMint(mintUrl));
  }

  async untrustMint(mintUrl: string): Promise<void> {
    this.logger?.info('Untrusting mint', { mintUrl });
    await this.mintRepo.setMintTrusted(mintUrl, false);
    await this.eventBus?.emit('mint:updated', await this.ensureUpdatedMint(mintUrl));
  }

  private async updateMint(mint: Mint): Promise<{ mint: Mint; keysets: Keyset[] }> {
    let mintInfo;
    try {
      this.logger?.debug('Fetching mint info', { mintUrl: mint.mintUrl });
      mintInfo = await this.mintAdapter.fetchMintInfo(mint.mintUrl);
    } catch (err) {
      this.logger?.error('Failed to fetch mint info', { mintUrl: mint.mintUrl, err });
      throw new MintFetchError(mint.mintUrl, undefined, err);
    }

    let keysets;
    try {
      this.logger?.debug('Fetching keysets', { mintUrl: mint.mintUrl });
      ({ keysets } = await this.mintAdapter.fetchKeysets(mint.mintUrl));
    } catch (err) {
      this.logger?.error('Failed to fetch keysets', { mintUrl: mint.mintUrl, err });
      throw new MintFetchError(mint.mintUrl, 'Failed to fetch keysets', err);
    }
    await Promise.all(
      keysets.map(async (ks) => {
        const existingKeyset = await this.keysetRepo.getKeysetById(mint.mintUrl, ks.id);
        if (existingKeyset) {
          const keysetModel: Omit<Keyset, 'keypairs' | 'updatedAt'> = {
            mintUrl: mint.mintUrl,
            id: ks.id,
            unit: ks.unit,
            active: ks.active,
            feePpk: ks.input_fee_ppk || 0,
          };
          return this.keysetRepo.updateKeyset(keysetModel);
        } else {
          try {
            const keysRes = await this.mintAdapter.fetchKeysForId(mint.mintUrl, ks.id);
            const keypairs = Object.fromEntries(
              Object.entries(keysRes).map(([k, v]) => [Number(k), v]),
            ) as Record<number, string>;
            return this.keysetRepo.addKeyset({
              mintUrl: mint.mintUrl,
              id: ks.id,
              unit: ks.unit,
              keypairs,
              active: ks.active,
              feePpk: ks.input_fee_ppk || 0,
            });
          } catch (err) {
            this.logger?.error('Failed to sync keyset', {
              mintUrl: mint.mintUrl,
              keysetId: ks.id,
              err,
            });
            throw new KeysetSyncError(mint.mintUrl, ks.id, undefined, err);
          }
        }
      }),
    );

    // Persist mint updates only after successful fetch and keyset sync
    mint.mintInfo = mintInfo;
    mint.updatedAt = Math.floor(Date.now() / 1000);
    await this.mintRepo.addOrUpdateMint(mint);

    const repoKeysets = await this.keysetRepo.getKeysetsByMintUrl(mint.mintUrl);
    this.logger?.info('Mint updated', { mintUrl: mint.mintUrl, keysets: repoKeysets.length });
    return { mint, keysets: repoKeysets };
  }
}
