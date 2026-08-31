import type {
  ClaimIdentity,
  ClaimedDurableEvent,
  CompactDurableEventResult,
  CompactDurableEventStreamOptions,
  DurableEventClaimMutationResult,
  DurableEventClaimOptions,
  DurableEventOutboxRepository,
  DurableEventRevisionBatch,
  DurableEventStorageStats,
  EnqueueDurableEventResult,
  OutstandingDurableEventContract,
  RequeueBlockedDurableEventOptions,
  SafeDurableEventFailure,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase } from '../index.ts';
import { SqliteDurableEventOutboxTransactionPort } from '../DurableEventOutboxTransactionPort.ts';

/** Creates a root convenience wrapper for adapter contract tests only. */
export function createTransactionalSqliteDurableEventOutboxRepository(
  database: SqlDatabase,
): DurableEventOutboxRepository {
  const transactions = new SqliteDurableEventOutboxTransactionPort(database);
  const write = <T>(operation: (repository: DurableEventOutboxRepository) => Promise<T>) =>
    transactions.run(operation);

  return {
    enqueueRevision(
      batch: DurableEventRevisionBatch,
      now: number,
    ): Promise<EnqueueDurableEventResult> {
      return write((repository) => repository.enqueueRevision(batch, now));
    },
    claimNext(options: DurableEventClaimOptions): Promise<ClaimedDurableEvent | null> {
      return write((repository) => repository.claimNext(options));
    },
    readAndValidateCurrentClaim(claim: ClaimIdentity): Promise<ClaimedDurableEvent | null> {
      return write((repository) => repository.readAndValidateCurrentClaim(claim));
    },
    markPublished(
      id: string,
      leaseToken: string,
      now: number,
    ): Promise<DurableEventClaimMutationResult> {
      return write((repository) => repository.markPublished(id, leaseToken, now));
    },
    reschedule(
      claim: ClaimIdentity,
      failure: SafeDurableEventFailure,
      availableAt: number,
    ): Promise<DurableEventClaimMutationResult> {
      return write((repository) => repository.reschedule(claim, failure, availableAt));
    },
    block(
      claim: ClaimIdentity,
      failure: SafeDurableEventFailure,
      now: number,
    ): Promise<DurableEventClaimMutationResult> {
      return write((repository) => repository.block(claim, failure, now));
    },
    requeueBlocked(options: RequeueBlockedDurableEventOptions): Promise<number> {
      return write((repository) => repository.requeueBlocked(options));
    },
    compactPublishedThrough(
      options: CompactDurableEventStreamOptions,
    ): Promise<CompactDurableEventResult> {
      return write((repository) => repository.compactPublishedThrough(options));
    },
    getStorageStats(): Promise<DurableEventStorageStats> {
      return write((repository) => repository.getStorageStats());
    },
    listOutstandingContracts(): Promise<readonly OutstandingDurableEventContract[]> {
      return write((repository) => repository.listOutstandingContracts());
    },
  };
}
