import type { OperationEventOutboxRepository } from '..';
import {
  operationEventLogicalKey,
  type OperationEventOutboxRecord,
} from '../../models/OperationEventOutbox';
import { cloneMemoryValue } from './clone';

export class MemoryOperationEventOutboxRepository implements OperationEventOutboxRepository {
  private readonly events = new Map<string, OperationEventOutboxRecord>();

  async enqueue(event: OperationEventOutboxRecord): Promise<void> {
    validateEvent(event);
    if (this.events.has(event.id)) {
      throw new Error(`Operation event outbox record with id ${event.id} already exists`);
    }
    const logicalKey = operationEventLogicalKey(event);
    for (const existing of this.events.values()) {
      if (operationEventLogicalKey(existing) === logicalKey) {
        throw new Error('Operation event outbox logical key already exists');
      }
    }
    this.events.set(event.id, cloneMemoryValue(event));
  }

  async getUnpublished(limit: number, now = Date.now()): Promise<OperationEventOutboxRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error('Outbox limit must be non-negative');
    return Array.from(this.events.values())
      .filter((event) => !event.publishedAt && (event.nextAttemptAt ?? 0) <= now)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((event) => cloneMemoryValue(event));
  }

  async markPublished(id: string, publishedAt: number): Promise<void> {
    const event = this.requireEvent(id);
    if (event.publishedAt) return;
    this.events.set(id, { ...event, publishedAt, lastError: undefined, nextAttemptAt: undefined });
  }

  async recordPublishFailure(id: string, nextAttemptAt: number, lastError: string): Promise<void> {
    const event = this.requireEvent(id);
    if (event.publishedAt) return;
    this.events.set(id, {
      ...event,
      publishAttempts: event.publishAttempts + 1,
      nextAttemptAt,
      lastError,
    });
  }

  private requireEvent(id: string): OperationEventOutboxRecord {
    const event = this.events.get(id);
    if (!event) throw new Error(`Operation event outbox record with id ${id} not found`);
    return event;
  }
}

function validateEvent(event: OperationEventOutboxRecord): void {
  if (!event.id || !event.operationId) throw new Error('Outbox record identity is required');
  if (!Number.isSafeInteger(event.revision) || event.revision < 0) {
    throw new Error('Outbox revision must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(event.publishAttempts) || event.publishAttempts < 0) {
    throw new Error('Outbox publish attempts must be a non-negative safe integer');
  }
  if (
    event.payload.operationId !== event.operationId ||
    event.payload.revision !== event.revision
  ) {
    throw new Error('Outbox payload identity must match its logical event key');
  }
}
