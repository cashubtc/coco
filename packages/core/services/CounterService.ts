import type { Counter } from "../models/Counter";
import type { CounterRepository } from "../repositories";

export class CounterService {
  private readonly counterRepo: CounterRepository;

  constructor(counterRepo: CounterRepository) {
    this.counterRepo = counterRepo;
  }

  async getCounter(mintUrl: string, keysetId: string): Promise<Counter> {
    const counter = await this.counterRepo.getCounter(mintUrl, keysetId);
    if (!counter) {
      const newCounter = {
        mintUrl,
        keysetId,
        counter: 0,
      };
      await this.counterRepo.setCounter(mintUrl, keysetId, 0);
      return newCounter;
    }
    return counter;
  }

  async incrementCounter(mintUrl: string, keysetId: string, n: number) {
    const current = await this.getCounter(mintUrl, keysetId);
    const updatedValue = current.counter + n;
    await this.counterRepo.setCounter(mintUrl, keysetId, updatedValue);
    return { ...current, counter: updatedValue };
  }
}
