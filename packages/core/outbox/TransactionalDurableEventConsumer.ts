import { DurableEventCorruptRecordError, DurableEventStaleClaimError } from './errors.ts';
import type { DurableEventOutboxConsumerWriter } from './repository.ts';
import type {
  ClaimedDurableEvent,
  DurableEventApplyResult,
  DurableEventContract,
} from './types.ts';
import {
  assertDurableEventContract,
  assertClaimedDurableEventIntegrity,
  durableEventContractKey,
} from './validation.ts';

export interface DurableEventConsumerTransactionScope<TScope> {
  readonly effect: TScope;
  readonly outbox: DurableEventOutboxConsumerWriter;
}

export interface DurableEventConsumerTransactionPort<TScope> {
  run<T>(work: (scope: DurableEventConsumerTransactionScope<TScope>) => Promise<T>): Promise<T>;
}

export interface TransactionalDurableEventConsumer<TScope> {
  readonly contract: DurableEventContract;
  /**
   * Apply only rollback-capable local effects through the supplied scope. External calls and
   * arbitrary callbacks cannot share the publication transaction and are not supported here.
   */
  apply(scope: TScope, event: ClaimedDurableEvent): Promise<DurableEventApplyResult>;
}

export interface DurableEventConsumerExecutor {
  readonly contract: DurableEventContract;
  execute(event: ClaimedDurableEvent, now: number): Promise<DurableEventApplyResult>;
}

function sameImmutableClaim(left: ClaimedDurableEvent, right: ClaimedDurableEvent): boolean {
  return (
    left.id === right.id &&
    left.leaseToken === right.leaseToken &&
    left.consumerId === right.consumerId &&
    left.eventType === right.eventType &&
    left.envelopeVersion === right.envelopeVersion &&
    left.payloadVersion === right.payloadVersion &&
    left.streamId === right.streamId &&
    left.streamRevision === right.streamRevision &&
    left.eventKey === right.eventKey &&
    left.contentHash === right.contentHash
  );
}

export function createDurableEventConsumerExecutor<TScope>(options: {
  readonly consumer: TransactionalDurableEventConsumer<TScope>;
  readonly transactionPort: DurableEventConsumerTransactionPort<TScope>;
}): DurableEventConsumerExecutor {
  const { consumer, transactionPort } = options;
  assertDurableEventContract(consumer.contract);
  return {
    contract: consumer.contract,
    async execute(claimedEvent, now) {
      if (durableEventContractKey(claimedEvent) !== durableEventContractKey(consumer.contract)) {
        throw new DurableEventCorruptRecordError(
          claimedEvent.id,
          'Claimed event does not match the registered consumer contract',
        );
      }
      return transactionPort.run(async ({ effect, outbox }) => {
        const current = await outbox.readAndValidateCurrentClaim({
          id: claimedEvent.id,
          leaseToken: claimedEvent.leaseToken,
        });
        if (!current || !sameImmutableClaim(claimedEvent, current)) {
          throw new DurableEventStaleClaimError(claimedEvent.id);
        }
        assertClaimedDurableEventIntegrity(current);
        const result = await consumer.apply(effect, current);
        const marked = await outbox.markPublished(current.id, current.leaseToken, now);
        if (marked !== 'updated') throw new DurableEventStaleClaimError(current.id);
        return result;
      });
    },
  };
}
