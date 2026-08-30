import type { Logger } from '../logging/Logger.ts';
import {
  DurableEventCommitUnknownError,
  DurableEventConsumerError,
  DurableEventCorruptRecordError,
  DurableEventStaleClaimError,
  DurableEventTransactionConflictError,
  DurableEventValidationError,
} from './errors.ts';
import type { DurableEventConsumerExecutor } from './TransactionalDurableEventConsumer.ts';
import type { DurableEventOutboxRepository } from './repository.ts';
import {
  addDurableEventDelay,
  durableEventRetryDelay,
  type DurableEventRetryPolicy,
} from './retry.ts';
import type { SafeDurableEventFailure } from './types.ts';
import { assertDurableEventContract, durableEventContractKey } from './validation.ts';

export interface DurableEventPublisherOptions {
  readonly repository: DurableEventOutboxRepository;
  readonly consumers: readonly DurableEventConsumerExecutor[];
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly retryPolicy: DurableEventRetryPolicy;
  readonly createLeaseToken: () => string;
  readonly now: () => number;
  readonly jitter: () => number;
  readonly logger?: Logger;
}

export interface DurableEventRunResult {
  readonly claimed: number;
  readonly published: number;
  readonly rescheduled: number;
  readonly blocked: number;
  readonly stale: number;
}

function safeFailure(error: unknown): { failure: SafeDurableEventFailure; retryable: boolean } {
  if (error instanceof DurableEventCorruptRecordError) {
    return { failure: { code: 'outbox.corrupt_record' }, retryable: false };
  }
  if (error instanceof DurableEventConsumerError) {
    return {
      failure: { code: error.code, message: error.safeMessage },
      retryable: error.retryable,
    };
  }
  return { failure: { code: 'outbox.consumer_failed' }, retryable: true };
}

export class DurableEventOutboxPublisher {
  private readonly consumers = new Map<string, DurableEventConsumerExecutor>();

  constructor(private readonly options: DurableEventPublisherOptions) {
    if (options.consumers.length === 0) {
      throw new DurableEventValidationError('at least one durable event consumer is required');
    }
    if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs < 1) {
      throw new DurableEventValidationError('leaseDurationMs must be a positive safe integer');
    }
    durableEventRetryDelay(1, options.retryPolicy, 0.5);
    for (const consumer of options.consumers) {
      assertDurableEventContract(consumer.contract);
      const key = durableEventContractKey(consumer.contract);
      if (this.consumers.has(key)) {
        throw new DurableEventValidationError('durable event consumer contracts must be unique');
      }
      this.consumers.set(key, consumer);
    }
  }

  async runOnce(limit: number): Promise<DurableEventRunResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DurableEventValidationError('publisher limit must be between 1 and 100');
    }
    const result = { claimed: 0, published: 0, rescheduled: 0, blocked: 0, stale: 0 };

    for (let index = 0; index < limit; index += 1) {
      const claim = await this.options.repository.claimNext({
        workerId: this.options.workerId,
        leaseToken: this.options.createLeaseToken(),
        leaseDurationMs: this.options.leaseDurationMs,
        now: this.options.now(),
        contracts: [...this.consumers.values()].map((consumer) => consumer.contract),
      });
      if (!claim) break;
      result.claimed += 1;
      const consumer = this.consumers.get(durableEventContractKey(claim));
      if (!consumer) {
        throw new DurableEventValidationError('repository returned an unsupported event contract');
      }

      try {
        await consumer.execute(claim, this.options.now());
        result.published += 1;
        this.options.logger?.debug('Published durable event', {
          eventId: claim.id,
          eventType: claim.eventType,
          streamId: claim.streamId,
          streamRevision: claim.streamRevision,
          claimCount: claim.claimCount,
        });
      } catch (error) {
        if (
          error instanceof DurableEventTransactionConflictError ||
          error instanceof DurableEventCommitUnknownError
        ) {
          throw error;
        }
        if (error instanceof DurableEventStaleClaimError) {
          result.stale += 1;
          continue;
        }

        const normalized = safeFailure(error);
        const failureCount = claim.failureCount + 1;
        const shouldBlock =
          !normalized.retryable || failureCount >= this.options.retryPolicy.maxFailures;
        if (shouldBlock) {
          const mutation = await this.options.repository.block(
            { id: claim.id, leaseToken: claim.leaseToken },
            normalized.failure,
            this.options.now(),
          );
          if (mutation === 'updated') result.blocked += 1;
          else result.stale += 1;
          continue;
        }

        const now = this.options.now();
        const delay = durableEventRetryDelay(
          failureCount,
          this.options.retryPolicy,
          this.options.jitter(),
        );
        const mutation = await this.options.repository.reschedule(
          { id: claim.id, leaseToken: claim.leaseToken },
          normalized.failure,
          addDurableEventDelay(now, delay),
        );
        if (mutation === 'updated') result.rescheduled += 1;
        else result.stale += 1;
      }
    }

    return result;
  }
}
