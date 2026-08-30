import type { Counter } from '../../models/Counter';
import type { CounterRepository } from '..';
import { cloneMemoryValue, COPY_MEMORY_REPOSITORY_STATE } from './MemoryRepositoryTransaction.ts';

export class MemoryCounterRepository implements CounterRepository {
  private counters: Map<string, Counter> = new Map();

  [COPY_MEMORY_REPOSITORY_STATE](source: MemoryCounterRepository): void {
    this.counters = cloneMemoryValue(source.counters);
  }

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
