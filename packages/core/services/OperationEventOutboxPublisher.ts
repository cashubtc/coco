import type { CoreEvents, EventBus } from '../events';
import type { Logger } from '../logging/Logger.ts';
import type { OperationEventOutboxRecord } from '../models/OperationEventOutbox.ts';
import type { OperationEventOutboxRepository } from '../repositories';

export interface OperationEventOutboxPublisherOptions {
  batchSize?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  now?: () => number;
  random?: () => number;
}

export class OperationEventOutboxPublisher {
  private readonly batchSize: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly repository: OperationEventOutboxRepository,
    private readonly bus: EventBus<CoreEvents>,
    private readonly logger?: Logger,
    options: OperationEventOutboxPublisherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async publishDue(now = this.now()): Promise<number> {
    const records = await this.repository.getUnpublished(this.batchSize, now);
    for (const record of records) await this.publish(record, now);
    return records.length;
  }

  private async publish(record: OperationEventOutboxRecord, attemptedAt: number): Promise<void> {
    try {
      await this.bus.emit(record.eventType, record.payload, { throwOnError: true });
      await this.repository.markPublished(record.id, Math.max(attemptedAt, this.now()));
    } catch (error) {
      const ceiling = Math.min(
        this.maxRetryDelayMs,
        this.baseRetryDelayMs * 2 ** Math.min(record.publishAttempts, 16),
      );
      const delay = Math.floor(this.random() * Math.max(1, ceiling));
      await this.repository.recordPublishFailure(
        record.id,
        attemptedAt + delay,
        'Mint swap event publication failed; retry is scheduled',
      );
      this.logger?.warn('Mint swap event publication delayed', {
        operationId: record.operationId,
        revision: record.revision,
        eventType: record.eventType,
      });
    }
  }
}
