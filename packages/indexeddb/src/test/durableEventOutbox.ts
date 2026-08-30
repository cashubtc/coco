import type {
  ClaimIdentity,
  ClaimedDurableEvent,
  CompactDurableEventResult,
  CompactDurableEventStreamOptions,
  DurableEventClaimMutationResult,
  DurableEventClaimOptions,
  DurableEventOutboxRepository,
  DurableEventRevisionBatch,
  DurableEventStorageLimits,
  DurableEventStorageStats,
  EnqueueDurableEventResult,
  OutstandingDurableEventContract,
  RequeueBlockedDurableEventOptions,
  SafeDurableEventFailure,
} from '@cashu/coco-core/adapter';
import type { IdbDb } from '../lib/db.ts';
import {
  configureIdbDurableEventOutboxStorageLimits,
  IdbDurableEventOutboxRepository,
  IDB_DURABLE_EVENT_OUTBOX_STORES,
} from '../repositories/DurableEventOutboxRepository.ts';

export function createTransactionalIdbDurableEventOutboxRepository(
  database: IdbDb,
): DurableEventOutboxRepository {
  const run = <T>(
    operation: (repository: IdbDurableEventOutboxRepository) => Promise<T>,
  ): Promise<T> =>
    database.runTransaction('rw', [...IDB_DURABLE_EVENT_OUTBOX_STORES], (transaction) =>
      operation(new IdbDurableEventOutboxRepository(transaction)),
    );

  return {
    enqueueRevision(
      batch: DurableEventRevisionBatch,
      now: number,
    ): Promise<EnqueueDurableEventResult> {
      return run((repository) => repository.enqueueRevision(batch, now));
    },
    claimNext(options: DurableEventClaimOptions): Promise<ClaimedDurableEvent | null> {
      return run((repository) => repository.claimNext(options));
    },
    readAndValidateCurrentClaim(claim: ClaimIdentity): Promise<ClaimedDurableEvent | null> {
      return run((repository) => repository.readAndValidateCurrentClaim(claim));
    },
    markPublished(
      id: string,
      leaseToken: string,
      now: number,
    ): Promise<DurableEventClaimMutationResult> {
      return run((repository) => repository.markPublished(id, leaseToken, now));
    },
    reschedule(
      claim: ClaimIdentity,
      failure: SafeDurableEventFailure,
      availableAt: number,
    ): Promise<DurableEventClaimMutationResult> {
      return run((repository) => repository.reschedule(claim, failure, availableAt));
    },
    block(
      claim: ClaimIdentity,
      failure: SafeDurableEventFailure,
      now: number,
    ): Promise<DurableEventClaimMutationResult> {
      return run((repository) => repository.block(claim, failure, now));
    },
    requeueBlocked(options: RequeueBlockedDurableEventOptions): Promise<number> {
      return run((repository) => repository.requeueBlocked(options));
    },
    compactPublishedThrough(
      options: CompactDurableEventStreamOptions,
    ): Promise<CompactDurableEventResult> {
      return run((repository) => repository.compactPublishedThrough(options));
    },
    getStorageStats(): Promise<DurableEventStorageStats> {
      return run((repository) => repository.getStorageStats());
    },
    listOutstandingContracts(): Promise<readonly OutstandingDurableEventContract[]> {
      return run((repository) => repository.listOutstandingContracts());
    },
  };
}

export function configureTransactionalIdbDurableEventOutboxStorageLimits(
  database: IdbDb,
  limits: DurableEventStorageLimits,
): Promise<void> {
  return database.runTransaction('rw', [...IDB_DURABLE_EVENT_OUTBOX_STORES], (transaction) =>
    configureIdbDurableEventOutboxStorageLimits(transaction, limits),
  );
}
