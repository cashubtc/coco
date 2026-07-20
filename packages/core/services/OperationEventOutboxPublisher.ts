import type { EventBus, CoreEvents } from '../events/index.ts';
import type { Logger } from '../logging/Logger.ts';
import type { MintSwapEventType } from '../operations/mintSwap/MintSwapOperation.ts';
import type { OperationEventOutboxRepository } from '../repositories/index.ts';

export interface OperationEventOutboxPublisherOptions {
  batchSize?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export class OperationEventOutboxPublisher {
  private readonly batchSize: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(
    private readonly repository: OperationEventOutboxRepository,
    private readonly bus: EventBus<CoreEvents>,
    private readonly logger?: Logger,
    options: OperationEventOutboxPublisherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
  }

  async publishDue(now = Date.now()): Promise<number> {
    const records = await this.repository.getUnpublished(this.batchSize, now);
    for (const record of records) {
      try {
        await this.emit(record.eventType, record.payload);
        await this.repository.markPublished(record.id, Date.now());
      } catch (error) {
        const delay = Math.min(
          this.maxRetryDelayMs,
          this.baseRetryDelayMs * 2 ** Math.min(record.publishAttempts, 16),
        );
        const message = error instanceof Error ? error.message : String(error);
        await this.repository.recordPublishFailure(record.id, now + delay, message);
        this.logger?.warn('Mint swap outbox publication delayed', {
          operationId: record.operationId,
          revision: record.revision,
          eventType: record.eventType,
          error: message,
        });
      }
    }
    return records.length;
  }

  private emit(event: MintSwapEventType, payload: CoreEvents[MintSwapEventType]): Promise<void> {
    return this.bus.emit(event, payload, { throwOnError: true });
  }
}
