export class SeedService {
  private readonly seedGetter: () => Promise<Uint8Array>;
  private readonly seedTtlMs: number;
  private cachedSeed: Uint8Array | null = null;
  private cachedUntil = 0;
  private inFlight: Promise<Uint8Array> | null = null;

  constructor(seedGetter: () => Promise<Uint8Array>, options?: { seedTtlMs?: number }) {
    this.seedGetter = seedGetter;
    this.seedTtlMs = Math.max(0, options?.seedTtlMs ?? 0);
  }

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

  clear(): void {
    this.cachedSeed = null;
    this.cachedUntil = 0;
  }
}
