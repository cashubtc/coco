import type {
  ClaimIdentity,
  ClaimedDurableEvent,
  DurableEventContract,
  DurableEventRevisionBatch,
  DurableEventStorageStats,
  OutstandingDurableEventContract,
  SafeDurableEventFailure,
} from './types.ts';

export interface EnqueueDurableEventResult {
  readonly outcome: 'inserted' | 'existing';
  readonly eventIds: readonly string[];
}

export interface DurableEventClaimOptions {
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  readonly now: number;
  readonly contracts: readonly DurableEventContract[];
}

export type DurableEventClaimMutationResult = 'updated' | 'stale';

export interface RequeueBlockedDurableEventOptions {
  readonly contract: DurableEventContract;
  readonly limit: number;
  readonly now: number;
}

export interface CompactDurableEventStreamOptions {
  readonly streamId: string;
  readonly throughRevision: number;
  readonly retentionCutoff: number;
  readonly now: number;
}

export interface CompactDurableEventResult {
  readonly compactedThroughRevision: number;
  readonly deletedEventRows: number;
  readonly deletedRevisionSeals: number;
}

export interface DurableEventOutboxWriter {
  /**
   * Store a complete sealed revision using the caller's active transaction. Implementations must
   * not open or retry a root transaction.
   */
  enqueueRevision(
    batch: DurableEventRevisionBatch,
    now: number,
  ): Promise<EnqueueDurableEventResult>;
}

export interface DurableEventOutboxConsumerWriter {
  /** Recheck token ownership and immutable event content inside the consumer transaction. */
  readAndValidateCurrentClaim(claim: ClaimIdentity): Promise<ClaimedDurableEvent | null>;
  /** Mark publication in the same transaction as the supported local consumer effect. */
  markPublished(
    id: string,
    leaseToken: string,
    now: number,
  ): Promise<DurableEventClaimMutationResult>;
}

export interface DurableEventOutboxCompactionWriter {
  /** Delete retained published rows while preserving the stream checkpoint against replay. */
  compactPublishedThrough(
    options: CompactDurableEventStreamOptions,
  ): Promise<CompactDurableEventResult>;
}

export interface DurableEventOutboxRepository
  extends
    DurableEventOutboxWriter,
    DurableEventOutboxConsumerWriter,
    DurableEventOutboxCompactionWriter {
  /** Claiming is at least once; a lease is an ownership fence, not an exactly-once promise. */
  claimNext(options: DurableEventClaimOptions): Promise<ClaimedDurableEvent | null>;
  reschedule(
    claim: ClaimIdentity,
    failure: SafeDurableEventFailure,
    availableAt: number,
  ): Promise<DurableEventClaimMutationResult>;
  block(
    claim: ClaimIdentity,
    failure: SafeDurableEventFailure,
    now: number,
  ): Promise<DurableEventClaimMutationResult>;
  requeueBlocked(options: RequeueBlockedDurableEventOptions): Promise<number>;
  getStorageStats(): Promise<DurableEventStorageStats>;
  listOutstandingContracts(): Promise<readonly OutstandingDurableEventContract[]>;
}

/**
 * Opens a host-owned root transaction and supplies an outbox repository bound to it.
 *
 * The scoped repository never opens a nested root transaction. Adapters can use this port for
 * publisher claims and administrative operations while feature gateways use their adapter's
 * combined wallet-and-outbox transaction scope.
 */
export interface DurableEventOutboxTransactionPort {
  run<T>(work: (outbox: DurableEventOutboxRepository) => Promise<T>): Promise<T>;
}

/** Adapter-specific transaction scope that commits wallet repositories and outbox state together. */
export type DurableEventOutboxHostTransactionScope<TRepositories> = TRepositories & {
  readonly durableEventOutbox: DurableEventOutboxRepository;
};
