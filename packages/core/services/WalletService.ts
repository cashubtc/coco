import {
  Mint,
  Wallet,
  type Keys,
  type MintKeys,
  type MintKeyset,
  type KeyChainCache,
  type AuthProvider,
  type OutputDataCreator,
} from '@cashu/cashu-ts';
import type { MintService } from './MintService';
import type { Logger } from '../logging/Logger.ts';
import type { SeedService } from './SeedService.ts';
import type { MintRequestProvider } from '../infra/MintRequestProvider.ts';
import { DEFAULT_UNIT, normalizeUnit } from '../amounts.ts';
import { normalizeMintUrl } from '../utils.ts';
import { DEFAULT_OUTPUT_DATA_CREATOR } from '../OutputDataCreator.ts';

interface CachedWallet {
  wallet: Wallet;
  lastCheck: number;
}

export class WalletService {
  private walletCache: Map<string, CachedWallet> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000;
  private readonly mintService: MintService;
  private readonly seedService: SeedService;
  private inFlight: Map<string, Promise<Wallet>> = new Map();
  private readonly logger?: Logger;
  private readonly requestProvider: MintRequestProvider;
  private readonly authProviderGetter?: (mintUrl: string) => AuthProvider | undefined;
  private readonly outputDataCreator: OutputDataCreator;

  constructor(
    mintService: MintService,
    seedService: SeedService,
    requestProvider: MintRequestProvider,
    logger?: Logger,
    authProviderGetter?: (mintUrl: string) => AuthProvider | undefined,
    outputDataCreator: OutputDataCreator = DEFAULT_OUTPUT_DATA_CREATOR,
  ) {
    this.mintService = mintService;
    this.seedService = seedService;
    this.requestProvider = requestProvider;
    this.logger = logger;
    this.authProviderGetter = authProviderGetter;
    this.outputDataCreator = outputDataCreator;
  }

  async getWallet(mintUrl: string, unit: string): Promise<Wallet> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new Error('mintUrl is required');
    }

    const normalizedMintUrl = normalizeMintUrl(mintUrl);
    const normalizedUnit = normalizeUnit(unit);
    const cacheKey = this.getWalletCacheKey(normalizedMintUrl, normalizedUnit);

    // Serve from cache when fresh
    const cached = this.walletCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.lastCheck < this.CACHE_TTL) {
      this.logger?.debug('Wallet served from cache', {
        mintUrl: normalizedMintUrl,
        unit: normalizedUnit,
      });
      return cached.wallet;
    }

    // De-duplicate concurrent requests per mintUrl
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = this.buildWallet(normalizedMintUrl, normalizedUnit).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  async getWalletWithActiveKeysetId(
    mintUrl: string,
    unit: string,
  ): Promise<{
    wallet: Wallet;
    keysetId: string;
    keyset: MintKeyset;
    keys: MintKeys;
    unit: string;
  }> {
    const normalizedUnit = normalizeUnit(unit);
    const wallet = await this.getWallet(mintUrl, normalizedUnit);
    const keyset = wallet.keyChain.getCheapestKeyset();
    const mintKeys = keyset.toMintKeys();
    const mintKeyset = keyset.toMintKeyset();

    if (mintKeys === null) {
      throw new Error('MintKeys is null. Cannot return a valid response.');
    }

    const keysetUnit = this.normalizeKeysetUnit(mintKeyset.unit);
    if (keysetUnit !== normalizedUnit) {
      throw new Error(
        `Active keyset ${keyset.id} unit ${keysetUnit} does not match requested unit ${normalizedUnit}`,
      );
    }

    return {
      wallet,
      keysetId: keyset.id,
      keyset: mintKeyset,
      keys: mintKeys,
      unit: normalizedUnit,
    };
  }

  /**
   * Clear cached wallet for a specific mint URL
   */
  clearCache(mintUrl: string, unit?: string): void {
    const normalizedMintUrl = normalizeMintUrl(mintUrl);
    if (unit !== undefined) {
      const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
      const cacheKey = this.getWalletCacheKey(normalizedMintUrl, normalizedUnit);
      this.walletCache.delete(cacheKey);
      this.inFlight.delete(cacheKey);
      this.logger?.debug('Wallet cache cleared', {
        mintUrl: normalizedMintUrl,
        unit: normalizedUnit,
      });
      return;
    }

    const prefix = `${normalizedMintUrl}::`;
    for (const key of this.walletCache.keys()) {
      if (key.startsWith(prefix)) {
        this.walletCache.delete(key);
      }
    }
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(prefix)) {
        this.inFlight.delete(key);
      }
    }
    this.logger?.debug('Wallet cache cleared', { mintUrl: normalizedMintUrl });
  }

  /**
   * Clear all cached wallets
   */
  clearAllCaches(): void {
    this.walletCache.clear();
    this.inFlight.clear();
    this.logger?.debug('All wallet caches cleared');
  }

  /**
   * Force refresh mint data and get fresh wallet
   */
  async refreshWallet(mintUrl: string, unit: string): Promise<Wallet> {
    const normalizedMintUrl = normalizeMintUrl(mintUrl);
    const normalizedUnit = normalizeUnit(unit);
    this.clearCache(normalizedMintUrl, normalizedUnit);
    await this.mintService.updateMintData(normalizedMintUrl);
    return this.getWallet(normalizedMintUrl, normalizedUnit);
  }

  private getWalletCacheKey(mintUrl: string, unit: string): string {
    return `${normalizeMintUrl(mintUrl)}::${normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT })}`;
  }

  private normalizeKeysetUnit(unit?: string | null): string {
    return normalizeUnit(unit || DEFAULT_UNIT, { defaultUnit: DEFAULT_UNIT });
  }

  private async buildWallet(mintUrl: string, unit: string): Promise<Wallet> {
    const normalizedMintUrl = normalizeMintUrl(mintUrl);
    const normalizedUnit = normalizeUnit(unit);
    const { mint, keysets } = await this.mintService.ensureUpdatedMint(normalizedMintUrl);

    const validKeysets = keysets.filter(
      (keyset) =>
        keyset.keypairs &&
        Object.keys(keyset.keypairs).length > 0 &&
        this.normalizeKeysetUnit(keyset.unit) === normalizedUnit,
    );

    if (validKeysets.length === 0) {
      throw new Error(
        `No valid keysets found for mint ${normalizedMintUrl} and unit ${normalizedUnit}`,
      );
    }

    const keysetCache = validKeysets.map((keyset) => ({
      id: keyset.id,
      unit: this.normalizeKeysetUnit(keyset.unit),
      active: keyset.active,
      input_fee_ppk: keyset.feePpk,
      keys: keyset.keypairs as Keys,
    }));

    const cache: KeyChainCache = {
      mintUrl: mint.mintUrl,
      keysets: keysetCache,
    };

    const seed = await this.seedService.getSeed();

    const requestFn = this.requestProvider.getRequestFn(normalizedMintUrl);
    const authProvider = this.authProviderGetter?.(normalizedMintUrl);
    const wallet = new Wallet(
      new Mint(normalizedMintUrl, { customRequest: requestFn, authProvider }),
      {
        unit: normalizedUnit,
        // @ts-ignore
        logger:
          this.logger && this.logger.child ? this.logger.child({ module: 'Wallet' }) : undefined,
        bip39seed: seed,
        outputDataCreator: this.outputDataCreator,
      },
    );
    wallet.loadMintFromCache(mint.mintInfo, cache);

    this.walletCache.set(this.getWalletCacheKey(normalizedMintUrl, normalizedUnit), {
      wallet,
      lastCheck: Date.now(),
    });

    this.logger?.info('Wallet built', {
      mintUrl: normalizedMintUrl,
      unit: normalizedUnit,
      keysetCount: validKeysets.length,
    });
    return wallet;
  }
}
