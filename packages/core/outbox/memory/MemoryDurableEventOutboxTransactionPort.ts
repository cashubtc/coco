import type {
  DurableEventOutboxRepository,
  DurableEventOutboxTransactionPort,
} from '../repository.ts';
import { MemoryDurableEventOutboxRepository } from './MemoryDurableEventOutboxRepository.ts';

/**
 * Serializes root in-memory outbox transactions with explicit clone-and-replace staging.
 *
 * This port commits only outbox state. A host that combines the outbox with other in-memory state
 * must stage that state in the same callback and commit both only after the callback succeeds.
 */
export class MemoryDurableEventOutboxTransactionPort implements DurableEventOutboxTransactionPort {
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly repository = new MemoryDurableEventOutboxRepository()) {}

  async run<T>(work: (outbox: DurableEventOutboxRepository) => Promise<T>): Promise<T> {
    const previousTransaction = this.transactionQueue;
    let release!: () => void;
    this.transactionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previousTransaction;
    try {
      const staged = this.repository.clone();
      const result = await work(staged);
      this.repository.replaceWith(staged);
      return result;
    } finally {
      release();
    }
  }
}
