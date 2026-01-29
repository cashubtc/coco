/**
 * Retrieves and caches a 64-byte seed with optional TTL.
 */
export class SeedService {
  private readonly seedGetter: () => Promise<Uint8Array>;
  private readonly seedTtlMs: number;
  private cachedSeed: Uint8Array | null = null;
  private cachedUntil = 0;
  private inFlight: Promise<Uint8Array> | null = null;

  /**
   * @param seedGetter Async seed provider that must return a 64-byte Uint8Array.
   * @param options Seed cache options.
   * @param options.seedTtlMs Cache TTL in milliseconds; 0 disables caching.
   */
  constructor(seedGetter: () => Promise<Uint8Array>, options?: { seedTtlMs?: number }) {
    this.seedGetter = seedGetter;
    this.seedTtlMs = Math.max(0, options?.seedTtlMs ?? 0);
  }

  /**
   * Returns a defensive copy of the current seed, using cache when enabled.
   * @throws Error when the seed provider returns an invalid seed.
   */
  async getSeed(): Promise<Uint8Array> {
    const now = Date.now();

    if (this.cachedSeed && now < this.cachedUntil) {
      return new Uint8Array(this.cachedSeed);
    }

    if (this.inFlight) {
      const seed = await this.inFlight;
      return new Uint8Array(seed);
    }

    this.inFlight = (async () => {
      const seed = await this.seedGetter();
      if (!(seed instanceof Uint8Array) || seed.length !== 64) {
        throw new Error('SeedService: seedGetter must return a 64-byte Uint8Array');
      }

      if (this.seedTtlMs > 0) {
        this.cachedSeed = new Uint8Array(seed);
        this.cachedUntil = Date.now() + this.seedTtlMs;
      } else {
        this.cachedSeed = null;
        this.cachedUntil = 0;
      }

      return seed;
    })();

    try {
      const seed = await this.inFlight;
      return new Uint8Array(seed);
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Clears any cached seed so the next call fetches a fresh one.
   */
  clear(): void {
    this.cachedSeed = null;
    this.cachedUntil = 0;
  }
}
