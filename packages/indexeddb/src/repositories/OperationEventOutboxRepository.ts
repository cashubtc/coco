import type {
  OperationEventOutboxRecord,
  OperationEventOutboxRepository,
} from '@cashu/coco-core/adapter';

import { IdbDb, type OperationEventOutboxRow } from '../lib/db.ts';

const STORE = 'coco_cashu_operation_event_outbox';

export class IdbOperationEventOutboxRepository implements OperationEventOutboxRepository {
  constructor(private readonly db: IdbDb) {}

  async enqueue(event: OperationEventOutboxRecord): Promise<void> {
    validateEvent(event);
    await this.table().add(toRow(event));
  }

  async getUnpublished(limit: number, now = Date.now()): Promise<OperationEventOutboxRecord[]> {
    const rows = await this.table().toArray();
    return rows
      .filter((row) => row.publishedAt === undefined && (row.nextAttemptAt ?? 0) <= now)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(fromRow);
  }

  async markPublished(id: string, publishedAt: number): Promise<void> {
    const row = await this.table().get(id);
    if (!row || row.publishedAt !== undefined) return;
    await this.table().put({
      ...row,
      publishedAt,
      nextAttemptAt: undefined,
      lastError: undefined,
    });
  }

  async recordPublishFailure(id: string, nextAttemptAt: number, lastError: string): Promise<void> {
    const row = await this.table().get(id);
    if (!row || row.publishedAt !== undefined) return;
    await this.table().put({
      ...row,
      publishAttempts: row.publishAttempts + 1,
      nextAttemptAt,
      lastError,
    });
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
  };
}

function fromRow(row: OperationEventOutboxRow): OperationEventOutboxRecord {
  return {
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
  };
}

function validateEvent(event: OperationEventOutboxRecord): void {
  if (
    event.payload.operationId !== event.operationId ||
    event.payload.revision !== event.revision
  ) {
    throw new Error('Outbox payload identity must match its logical event key');
  }
}
