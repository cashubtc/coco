import type {
  DurableEventOutboxRepository,
  DurableEventOutboxTransactionPort,
} from '@cashu/coco-core/adapter';
import type { IdbDb } from '../lib/db.ts';
import {
  IdbDurableEventOutboxRepository,
  IDB_DURABLE_EVENT_OUTBOX_STORES,
} from './DurableEventOutboxRepository.ts';

/** Public root transaction capability used by publishers and outbox administration. */
export class IdbDurableEventOutboxTransactionPort implements DurableEventOutboxTransactionPort {
  constructor(private readonly database: IdbDb) {}

  run<T>(work: (outbox: DurableEventOutboxRepository) => Promise<T>): Promise<T> {
    return this.database.runTransaction('rw', [...IDB_DURABLE_EVENT_OUTBOX_STORES], (transaction) =>
      work(new IdbDurableEventOutboxRepository(transaction)),
    );
  }
}
