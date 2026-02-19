import { Mint, Wallet, type MintKeys, type MintKeyset, type KeyChainCache } from '@cashu/cashu-ts';
import type { MintService } from './MintService';
import type { Logger } from '../logging/Logger.ts';
import type { SeedService } from './SeedService.ts';
import type { MintRequestProvider } from '../infra/MintRequestProvider.ts';

interface CachedWallet {
  wallet: Wallet;
  lastCheck: number;
}

const DEFAULT_UNIT = 'sat';

export class WalletService {
  private walletCache: Map<string, CachedWallet> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000;
  private readonly mintService: MintService;
  private readonly seedService: SeedService;
  private inFlight: Map<string, Promise<Wallet>> = new Map();
  private readonly logger?: Logger;
  private readonly requestProvider: MintRequestProvider;

  constructor(
    mintService: MintService,
    seedService: SeedService,
    requestProvider: MintRequestProvider,
    logger?: Logger,
  ) {
    this.mintService = mintService;
    this.seedService = seedService;
    this.requestProvider = requestProvider;
    this.logger = logger;
  }

  /**
   * Build a cache key for the wallet cache.
   * Format: `${mintUrl}:${unit}`
   */
  private getCacheKey(mintUrl: string, unit: string): string {
    return `${mintUrl}:${unit}`;
  }

  async getWallet(mintUrl: string, unit: string = DEFAULT_UNIT): Promise<Wallet> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new Error('mintUrl is required');
    }

    const cacheKey = this.getCacheKey(mintUrl, unit);

    // Serve from cache when fresh
    const cached = this.walletCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.lastCheck < this.CACHE_TTL) {
      this.logger?.debug('Wallet served from cache', { mintUrl, unit });
      return cached.wallet;
    }

    // De-duplicate concurrent requests per mintUrl+unit
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = this.buildWallet(mintUrl, unit).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  async getWalletWithActiveKeysetId(
    mintUrl: string,
    unit: string = DEFAULT_UNIT,
  ): Promise<{
    wallet: Wallet;
    keysetId: string;
    keyset: MintKeyset;
    keys: MintKeys;
  }> {
    const wallet = await this.getWallet(mintUrl, unit);
    const keyset = wallet.keyChain.getCheapestKeyset();
    const mintKeys = keyset.toMintKeys();

    if (mintKeys === null) {
      throw new Error('MintKeys is null. Cannot return a valid response.');
    }

    return {
      wallet,
      keysetId: keyset.id,
      keyset: keyset.toMintKeyset(),
      keys: mintKeys,
    };
  }

  /**
   * Clear cached wallet for a specific mint URL and optionally a specific unit.
   * If unit is not provided, clears all cached wallets for the mint URL.
   */
  clearCache(mintUrl: string, unit?: string): void {
    if (unit) {
      const cacheKey = this.getCacheKey(mintUrl, unit);
      this.walletCache.delete(cacheKey);
      this.logger?.debug('Wallet cache cleared', { mintUrl, unit });
    } else {
      // Clear all units for this mint
      const keysToDelete: string[] = [];
      for (const key of this.walletCache.keys()) {
        if (key.startsWith(`${mintUrl}:`)) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        this.walletCache.delete(key);
      }
      this.logger?.debug('Wallet cache cleared for all units', { mintUrl });
    }
  }

  /**
   * Clear all cached wallets
   */
  clearAllCaches(): void {
    this.walletCache.clear();
    this.logger?.debug('All wallet caches cleared');
  }

  /**
   * Force refresh mint data and get fresh wallet
   */
  async refreshWallet(mintUrl: string, unit: string = DEFAULT_UNIT): Promise<Wallet> {
    const cacheKey = this.getCacheKey(mintUrl, unit);
    this.walletCache.delete(cacheKey);
    this.inFlight.delete(cacheKey);
    await this.mintService.updateMintData(mintUrl);
    return this.getWallet(mintUrl, unit);
  }

  /**
   * Get all supported units for a mint.
   * Returns a list of unique units from active keysets.
   */
  async getSupportedUnits(mintUrl: string): Promise<string[]> {
    const { keysets } = await this.mintService.ensureUpdatedMint(mintUrl);
    const units = new Set<string>();
    for (const keyset of keysets) {
      if (keyset.active && keyset.keypairs && Object.keys(keyset.keypairs).length > 0) {
        units.add(keyset.unit);
      }
    }
    return Array.from(units);
  }

  private async buildWallet(mintUrl: string, unit: string): Promise<Wallet> {
    const { mint, keysets } = await this.mintService.ensureUpdatedMint(mintUrl);

    const validKeysets = keysets.filter(
      (keyset) =>
        keyset.keypairs && Object.keys(keyset.keypairs).length > 0 && keyset.unit === unit,
    );

    if (validKeysets.length === 0) {
      throw new Error(`No valid keysets found for mint ${mintUrl} with unit ${unit}`);
    }

    const keysetCache = validKeysets.map((keyset) => ({
      id: keyset.id,
      unit: keyset.unit,
      active: keyset.active,
      input_fee_ppk: keyset.feePpk,
      keys: keyset.keypairs,
    }));

    const cache: KeyChainCache = {
      mintUrl: mint.mintUrl,
      unit,
      keysets: keysetCache,
    };

    const seed = await this.seedService.getSeed();

    const requestFn = this.requestProvider.getRequestFn(mintUrl);
    const wallet = new Wallet(new Mint(mintUrl, { customRequest: requestFn }), {
      unit,
      // @ts-ignore
      logger:
        this.logger && this.logger.child ? this.logger.child({ module: 'Wallet' }) : undefined,
      bip39seed: seed,
    });
    wallet.loadMintFromCache(mint.mintInfo, cache);

    const cacheKey = this.getCacheKey(mintUrl, unit);
    this.walletCache.set(cacheKey, {
      wallet,
      lastCheck: Date.now(),
    });

    this.logger?.info('Wallet built', { mintUrl, unit, keysetCount: validKeysets.length });
    return wallet;
  }
}
