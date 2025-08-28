import { CashuMint, CashuWallet, type Keys, type MintKeys, type MintKeyset } from '@cashu/cashu-ts';
import type { MintService } from './MintService';
import type { Logger } from '../logging/Logger.ts';
import type { SeedService } from './SeedService.ts';

interface CachedWallet {
  wallet: CashuWallet;
  lastCheck: number;
}

export class WalletService {
  private walletCache: Map<string, CachedWallet> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000;
  private readonly mintService: MintService;
  private readonly seedService: SeedService;
  private inFlight: Map<string, Promise<CashuWallet>> = new Map();
  private readonly logger?: Logger;

  constructor(mintService: MintService, seedService: SeedService, logger?: Logger) {
    this.mintService = mintService;
    this.seedService = seedService;
    this.logger = logger;
  }

  async getWallet(mintUrl: string): Promise<CashuWallet> {
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
    wallet: CashuWallet;
    keysetId: string;
    keyset: MintKeyset;
    keys: MintKeys;
  }> {
    const wallet = await this.getWallet(mintUrl);
    const keyset = wallet.getActiveKeyset(wallet.keysets);
    const keys = await wallet.getKeys(keyset.id);
    return { wallet, keysetId: keyset.id, keyset, keys };
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
  async refreshWallet(mintUrl: string): Promise<CashuWallet> {
    this.clearCache(mintUrl);
    this.inFlight.delete(mintUrl);
    await this.mintService.updateMintData(mintUrl);
    return this.getWallet(mintUrl);
  }
  private async buildWallet(mintUrl: string): Promise<CashuWallet> {
    const { mint, keysets } = await this.mintService.ensureUpdatedMint(mintUrl);

    const validKeysets = keysets.filter(
      (keyset) => keyset.keypairs && Object.keys(keyset.keypairs).length > 0,
    );

    if (validKeysets.length === 0) {
      throw new Error(`No valid keysets found for mint ${mintUrl}`);
    }

    const keys = validKeysets.map((keyset) => ({
      id: keyset.id,
      unit: 'sat' as const,
      keys: keyset.keypairs,
    }));

    const compatibleKeysets: MintKeyset[] = validKeysets.map((k) => ({
      id: k.id,
      unit: 'sat' as const,
      active: k.active,
      input_fee_ppk: k.feePpk,
    }));

    const seed = await this.seedService.getSeed();

    const wallet = new CashuWallet(new CashuMint(mintUrl), {
      mintInfo: mint.mintInfo,
      keys,
      keysets: compatibleKeysets,
      // @ts-ignore
      logger:
        this.logger && this.logger.child ? this.logger.child({ module: 'Wallet' }) : undefined,
      seed,
    });

    this.walletCache.set(mintUrl, {
      wallet,
      lastCheck: Date.now(),
    });

    this.logger?.info('Wallet built', { mintUrl, keysetCount: validKeysets.length });
    return wallet;
  }
}
