import { Mint, Wallet, type MintKeys, type MintKeyset, type KeyChainCache } from '@cashu/cashu-ts';
import type { MintService } from './MintService';
import type { Logger } from '../logging/Logger.ts';
import type { SeedService } from './SeedService.ts';
import type { MintRequestProvider } from '../infra/MintRequestProvider.ts';

interface CachedWallet {
  wallet: Wallet;
  lastCheck: number;
}

//TODO: Allow dynamic units at some point
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

  async getWallet(mintUrl: string): Promise<Wallet> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new Error('mintUrl is required');
    }

    // Serve from cache when fresh
    const cached = this.walletCache.get(mintUrl);
    const now = Date.now();
    if (cached && now - cached.lastCheck < this.CACHE_TTL) {
      this.logger?.debug('Wallet served from cache', { mintUrl });
      return cached.wallet;
    }

    // De-duplicate concurrent requests per mintUrl
    const existing = this.inFlight.get(mintUrl);
    if (existing) return existing;

    const promise = this.buildWallet(mintUrl).finally(() => {
      this.inFlight.delete(mintUrl);
    });
    this.inFlight.set(mintUrl, promise);
    return promise;
  }

  async getWalletWithActiveKeysetId(mintUrl: string): Promise<{
    wallet: Wallet;
    keysetId: string;
    keyset: MintKeyset;
    keys: MintKeys;
  }> {
    const wallet = await this.getWallet(mintUrl);
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
   * Clear cached wallet for a specific mint URL
   */
  clearCache(mintUrl: string): void {
    this.walletCache.delete(mintUrl);
    this.logger?.debug('Wallet cache cleared', { mintUrl });
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
  async refreshWallet(mintUrl: string): Promise<Wallet> {
    this.clearCache(mintUrl);
    this.inFlight.delete(mintUrl);
    await this.mintService.updateMintData(mintUrl);
    return this.getWallet(mintUrl);
  }

  private async buildWallet(mintUrl: string): Promise<Wallet> {
    const { mint, keysets } = await this.mintService.ensureUpdatedMint(mintUrl);

    const validKeysets = keysets.filter(
      (keyset) =>
        keyset.keypairs && Object.keys(keyset.keypairs).length > 0 && keyset.unit === DEFAULT_UNIT,
    );

    if (validKeysets.length === 0) {
      throw new Error(`No valid keysets found for mint ${mintUrl}`);
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
      unit: DEFAULT_UNIT,
      keysets: keysetCache,
    };

    const seed = await this.seedService.getSeed();

    const requestFn = this.requestProvider.getRequestFn(mintUrl);
    const wallet = new Wallet(new Mint(mintUrl, { customRequest: requestFn }), {
      unit: DEFAULT_UNIT,
      // @ts-ignore
      logger:
        this.logger && this.logger.child ? this.logger.child({ module: 'Wallet' }) : undefined,
      bip39seed: seed,
    });
    wallet.loadMintFromCache(mint.mintInfo, cache);

    this.walletCache.set(mintUrl, {
      wallet,
      lastCheck: Date.now(),
    });

    this.logger?.info('Wallet built', { mintUrl, keysetCount: validKeysets.length });
    return wallet;
  }
}
