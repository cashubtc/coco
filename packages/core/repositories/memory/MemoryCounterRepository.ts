import type { Counter } from '../../models/Counter';
import type { CounterRepository } from '..';

export class MemoryCounterRepository implements CounterRepository {
  private counters: Map<string, Counter> = new Map();

  private key(mintUrl: string, keysetId: string): string {
    return `${mintUrl}::${keysetId}`;
  }

  async getCounter(mintUrl: string, keysetId: string): Promise<Counter | null> {
    return this.counters.get(this.key(mintUrl, keysetId)) ?? null;
  }

  async setCounter(mintUrl: string, keysetId: string, counter: number): Promise<void> {
    const key = this.key(mintUrl, keysetId);
    this.counters.set(key, { mintUrl, keysetId, counter });
  }
}
