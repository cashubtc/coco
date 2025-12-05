import type { Logger } from '../logging/Logger.ts';
import { RequestRateLimiter } from './RequestRateLimiter.ts';

/**
 * A function compatible with cashu-ts's `_customRequest` parameter.
 */
export type MintRequestFn = <T>(options: {
  endpoint: string;
  requestBody?: Record<string, unknown>;
  headers?: Record<string, string>;
}) => Promise<T>;

export interface MintRequestProviderOptions {
  /** Default capacity for rate limiters (default: 20) */
  capacity?: number;
  /** Default refill rate per minute (default: 20) */
  refillPerMinute?: number;
  /** Path prefixes to bypass rate limiting */
  bypassPathPrefixes?: string[];
  /** Optional per-mint configuration override */
  configForMint?: (mintUrl: string) => Partial<{
    capacity: number;
    refillPerMinute: number;
    bypassPathPrefixes: string[];
  }>;
  logger?: Logger;
}

/**
 * Manages per-mint request rate limiters.
 *
 * This class provides a centralized way to share rate limiters across
 * all components that need to make HTTP requests to mints (WalletService,
 * MintAdapter, etc.).
 */
export class MintRequestProvider {
  private readonly limiters = new Map<string, RequestRateLimiter>();
  private readonly options: Required<
    Omit<MintRequestProviderOptions, 'configForMint' | 'logger'>
  > & {
    configForMint?: MintRequestProviderOptions['configForMint'];
    logger?: Logger;
  };

  constructor(options?: MintRequestProviderOptions) {
    this.options = {
      capacity: options?.capacity ?? 20,
      refillPerMinute: options?.refillPerMinute ?? 20,
      bypassPathPrefixes: options?.bypassPathPrefixes ?? [],
      configForMint: options?.configForMint,
      logger: options?.logger,
    };
  }

  /**
   * Get the request function for a specific mint.
   * Creates a new rate limiter if one doesn't exist for this mint.
   */
  getRequestFn(mintUrl: string): MintRequestFn {
    return this.getOrCreateLimiter(mintUrl).request;
  }

  /**
   * Get or create a rate limiter for a specific mint.
   */
  private getOrCreateLimiter(mintUrl: string): RequestRateLimiter {
    const existing = this.limiters.get(mintUrl);
    if (existing) return existing;

    const perMintConfig = this.options.configForMint?.(mintUrl) ?? {};
    const limiter = new RequestRateLimiter({
      capacity: perMintConfig.capacity ?? this.options.capacity,
      refillPerMinute: perMintConfig.refillPerMinute ?? this.options.refillPerMinute,
      bypassPathPrefixes: perMintConfig.bypassPathPrefixes ?? this.options.bypassPathPrefixes,
      logger: this.options.logger?.child
        ? this.options.logger.child({ module: 'RequestRateLimiter', mintUrl })
        : this.options.logger,
    });

    this.limiters.set(mintUrl, limiter);
    return limiter;
  }

  /**
   * Clear the rate limiter for a specific mint.
   */
  clearMint(mintUrl: string): void {
    this.limiters.delete(mintUrl);
  }

  /**
   * Clear all rate limiters.
   */
  clearAll(): void {
    this.limiters.clear();
  }
}
