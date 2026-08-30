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
import { SqliteDurableEventOutboxRepository } from '../repositories/DurableEventOutboxRepository.ts';

/** Creates a root convenience wrapper for adapter contract tests only. */
export function createTransactionalSqliteDurableEventOutboxRepository(
  database: SqlDatabase,
): DurableEventOutboxRepository {
  const isBusy = (error: unknown): boolean =>
    error instanceof Error &&
    'code' in error &&
    (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED');

  const write = <T>(
    operation: (repository: SqliteDurableEventOutboxRepository) => Promise<T>,
  ): Promise<T> => {
    const attempt = async (remainingAttempts: number): Promise<T> => {
      try {
        return await database.transaction(
          (transaction) => operation(new SqliteDurableEventOutboxRepository(transaction)),
          { mode: 'immediate' },
        );
      } catch (error) {
        if (!isBusy(error) || remainingAttempts === 0) throw error;
        await Promise.resolve();
        return attempt(remainingAttempts - 1);
      }
    };
    return attempt(50);
  };

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
