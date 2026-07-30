import type { OperationEventOutboxRepository } from '..';
import {
  isOperationEventDue,
  isOperationEventPublished,
  operationEventLogicalKey,
  validateOperationEventOutboxRecord,
  type OperationEventOutboxRecord,
} from '../../models/OperationEventOutbox';
import { cloneMemoryValue } from './clone';

export class MemoryOperationEventOutboxRepository implements OperationEventOutboxRepository {
  private readonly events = new Map<string, OperationEventOutboxRecord>();

  async enqueue(event: OperationEventOutboxRecord): Promise<void> {
    validateOperationEventOutboxRecord(event);
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
    assertNonNegativeSafeInteger(limit, 'Outbox limit');
    assertNonNegativeSafeInteger(now, 'Outbox due time');
    return Array.from(this.events.values())
      .filter((event) => isOperationEventDue(event, now))
      .sort(
        (left, right) =>
          (left.nextAttemptAt ?? 0) - (right.nextAttemptAt ?? 0) ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map((event) => cloneMemoryValue(event));
  }

  async markPublished(id: string, publishedAt: number): Promise<void> {
    const event = this.requireEvent(id);
    if (isOperationEventPublished(event)) return;
    const published = {
      ...event,
      publishedAt,
      lastError: undefined,
      nextAttemptAt: undefined,
    };
    validateOperationEventOutboxRecord(published);
    this.events.set(id, cloneMemoryValue(published));
  }

  async recordPublishFailure(id: string, nextAttemptAt: number, lastError: string): Promise<void> {
    const event = this.requireEvent(id);
    if (isOperationEventPublished(event)) return;
    const failed = {
      ...event,
      publishAttempts: event.publishAttempts + 1,
      nextAttemptAt,
      lastError,
    };
    validateOperationEventOutboxRecord(failed);
    this.events.set(id, cloneMemoryValue(failed));
  }

  private requireEvent(id: string): OperationEventOutboxRecord {
    const event = this.events.get(id);
    if (!event) throw new Error(`Operation event outbox record with id ${id} not found`);
    return event;
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}
