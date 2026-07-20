import type {
  OperationEventOutboxRecord,
  OperationEventOutboxRepository,
} from '@cashu/coco-core/adapter';

import type { SqlDatabase } from '../index.ts';

interface OutboxRow {
  id: string;
  operationId: string;
  revision: number;
  eventType: OperationEventOutboxRecord['eventType'];
  payloadJson: string;
  createdAt: number;
  publishedAt: number | null;
  publishAttempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
}

const SELECT_COLUMNS = `
  id, operationId, revision, eventType, payloadJson, createdAt, publishedAt,
  publishAttempts, nextAttemptAt, lastError
`;

export class SqliteOperationEventOutboxRepository implements OperationEventOutboxRepository {
  constructor(private readonly db: SqlDatabase) {}

  async enqueue(event: OperationEventOutboxRecord): Promise<void> {
    validateEvent(event);
    await this.db.run(
      `INSERT INTO coco_cashu_operation_event_outbox (
        id, operationId, revision, eventType, payloadJson, createdAt, publishedAt,
        publishAttempts, nextAttemptAt, lastError
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.operationId,
        event.revision,
        event.eventType,
        JSON.stringify(event.payload),
        event.createdAt,
        event.publishedAt ?? null,
        event.publishAttempts,
        event.nextAttemptAt ?? null,
        event.lastError ?? null,
      ],
    );
  }

  async getUnpublished(limit: number, now = Date.now()): Promise<OperationEventOutboxRecord[]> {
    const rows = await this.db.all<OutboxRow>(
      `SELECT ${SELECT_COLUMNS} FROM coco_cashu_operation_event_outbox
       WHERE publishedAt IS NULL AND COALESCE(nextAttemptAt, 0) <= ?
       ORDER BY createdAt ASC, id ASC LIMIT ?`,
      [now, limit],
    );
    return rows.map(fromRow);
  }

  async markPublished(id: string, publishedAt: number): Promise<void> {
    await this.db.run(
      `UPDATE coco_cashu_operation_event_outbox
       SET publishedAt = COALESCE(publishedAt, ?), nextAttemptAt = NULL, lastError = NULL
       WHERE id = ?`,
      [publishedAt, id],
    );
  }

  async recordPublishFailure(id: string, nextAttemptAt: number, lastError: string): Promise<void> {
    await this.db.run(
      `UPDATE coco_cashu_operation_event_outbox
       SET publishAttempts = publishAttempts + 1, nextAttemptAt = ?, lastError = ?
       WHERE id = ? AND publishedAt IS NULL`,
      [nextAttemptAt, lastError, id],
    );
  }
}

function fromRow(row: OutboxRow): OperationEventOutboxRecord {
  return {
    id: row.id,
    operationId: row.operationId,
    revision: row.revision,
    eventType: row.eventType,
    payload: JSON.parse(row.payloadJson),
    createdAt: row.createdAt,
    publishedAt: row.publishedAt ?? undefined,
    publishAttempts: row.publishAttempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    lastError: row.lastError ?? undefined,
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
