import type { Counter } from '../models/Counter';
import type { CounterRepository } from '../repositories';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { Logger } from '../logging/Logger.ts';
import { assertNonNegativeInteger } from '../utils.ts';

export class CounterService {
  private readonly counterRepo: CounterRepository;
  private readonly eventBus?: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  constructor(counterRepo: CounterRepository, logger?: Logger, eventBus?: EventBus<CoreEvents>) {
    this.counterRepo = counterRepo;
    this.logger = logger;
    this.eventBus = eventBus;
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
      this.logger?.debug('Initialized counter', { mintUrl, keysetId });
      return newCounter;
    }
    return counter;
  }

  async incrementCounter(mintUrl: string, keysetId: string, n: number) {
    assertNonNegativeInteger('n', n, this.logger);
    const current = await this.getCounter(mintUrl, keysetId);
    const updatedValue = current.counter + n;
    await this.counterRepo.setCounter(mintUrl, keysetId, updatedValue);
    const updated = { ...current, counter: updatedValue };
    await this.eventBus?.emit('counter:updated', updated);
    this.logger?.info('Counter incremented', { mintUrl, keysetId, counter: updatedValue });
    return updated;
  }

  async overwriteCounter(mintUrl: string, keysetId: string, counter: number) {
    assertNonNegativeInteger('counter', counter, this.logger);
    await this.counterRepo.setCounter(mintUrl, keysetId, counter);
    const updated = { mintUrl, keysetId, counter };
    await this.eventBus?.emit('counter:updated', updated);
    this.logger?.info('Counter overwritten', { mintUrl, keysetId, counter });
    return updated;
  }
}
