import type {
  OperationEventOutboxRecord,
  OperationEventOutboxRepository,
} from '@cashu/coco-core/adapter';
import {
  isOperationEventPublished,
  validateOperationEventOutboxRecord,
} from '@cashu/coco-core/adapter';
import Dexie from 'dexie';

import { IdbDb, type OperationEventOutboxRow } from '../lib/db.ts';

const STORE = 'coco_cashu_operation_event_outbox';

export class IdbOperationEventOutboxRepository implements OperationEventOutboxRepository {
  constructor(private readonly db: IdbDb) {}

  async enqueue(event: OperationEventOutboxRecord): Promise<void> {
    validateOperationEventOutboxRecord(event);
    await this.table().add(toRow(event));
  }

  async getById(id: string): Promise<OperationEventOutboxRecord | null> {
    const row = await this.table().get(id);
    return row ? fromRow(row) : null;
  }

  async getUnpublished(limit: number, now = Date.now()): Promise<OperationEventOutboxRecord[]> {
    assertNonNegativeSafeInteger(limit, 'Outbox limit');
    assertNonNegativeSafeInteger(now, 'Outbox due time');
    if (limit === 0) return [];
    const rows = await this.table()
      .where('[publicationState+dueAt+createdAt+id]')
      .between(
        ['pending', Dexie.minKey, Dexie.minKey, Dexie.minKey],
        ['pending', now, Dexie.maxKey, Dexie.maxKey],
      )
      .limit(limit)
      .toArray();
    return rows.map(fromRow);
  }

  async markPublished(id: string, publishedAt: number): Promise<void> {
    await this.db.runTransaction('rw', [STORE], async () => {
      const event = await this.requireEvent(id);
      if (isOperationEventPublished(event)) return;
      const published = {
        ...event,
        publishedAt,
        publishAttempts: event.publishAttempts + 1,
        nextAttemptAt: undefined,
        lastError: undefined,
      };
      validateOperationEventOutboxRecord(published);
      await this.table().put(toRow(published));
    });
  }

  async recordPublishFailure(id: string, nextAttemptAt: number, lastError: string): Promise<void> {
    await this.db.runTransaction('rw', [STORE], async () => {
      const event = await this.requireEvent(id);
      if (isOperationEventPublished(event)) return;
      const failed = {
        ...event,
        publishAttempts: event.publishAttempts + 1,
        nextAttemptAt,
        lastError,
      };
      validateOperationEventOutboxRecord(failed);
      await this.table().put(toRow(failed));
    });
  }

  private async requireEvent(id: string): Promise<OperationEventOutboxRecord> {
    const event = await this.getById(id);
    if (!event) throw new Error(`Operation event outbox record with id ${id} not found`);
    return event;
  }

  private table() {
    return this.db.table<OperationEventOutboxRow, string>(STORE);
  }
}

function toRow(event: OperationEventOutboxRecord): OperationEventOutboxRow {
  return {
    id: event.id,
    operationId: event.operationId,
    revision: event.revision,
    eventType: event.eventType,
    payloadJson: JSON.stringify(event.payload),
    createdAt: event.createdAt,
    publishedAt: event.publishedAt,
    publishAttempts: event.publishAttempts,
    nextAttemptAt: event.nextAttemptAt,
    lastError: event.lastError,
    publicationState: event.publishedAt === undefined ? 'pending' : 'published',
    dueAt: event.nextAttemptAt ?? 0,
  };
}

function fromRow(row: OperationEventOutboxRow): OperationEventOutboxRecord {
  return validateOperationEventOutboxRecord({
    id: row.id,
    operationId: row.operationId,
    revision: row.revision,
    eventType: row.eventType as OperationEventOutboxRecord['eventType'],
    payload: JSON.parse(row.payloadJson),
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
    publishAttempts: row.publishAttempts,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
  });
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}
