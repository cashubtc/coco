import {
  DurableEventBatchConflictError,
  DurableEventCapacityExceededError,
  DurableEventInvariantError,
  DurableEventRevisionAlreadyCompactedError,
  DurableEventTransactionConflictError,
  DurableEventValidationError,
} from '../errors.ts';
import { DEFAULT_DURABLE_EVENT_STORAGE_LIMITS } from '../types.ts';
import type {
  CompactDurableEventResult,
  CompactDurableEventStreamOptions,
  DurableEventClaimMutationResult,
  DurableEventClaimOptions,
  DurableEventOutboxRepository,
  EnqueueDurableEventResult,
  RequeueBlockedDurableEventOptions,
} from '../repository.ts';
import type {
  ClaimIdentity,
  ClaimedDurableEvent,
  DurableEventContract,
  DurableEventRecord,
  DurableEventRevisionBatch,
  DurableEventRevisionSeal,
  DurableEventStorageLimits,
  DurableEventStorageStats,
  OutstandingDurableEventContract,
  SafeDurableEventFailure,
} from '../types.ts';
import {
  assertDurableEventContract,
  assertDurableEventOpaqueIdentifier,
  assertDurableEventTimestamp,
  assertSafeDurableEventFailure,
  durableEventContractKey,
  prepareDurableEventRevisionBatch,
} from '../validation.ts';

interface MemoryDurableEventOutboxState {
  events: Map<string, DurableEventRecord>;
  seals: Map<string, DurableEventRevisionSeal>;
  checkpoints: Map<string, number>;
}

function sealKey(streamId: string, streamRevision: number): string {
  return `${streamId}\u0000${streamRevision}`;
}

function clonePayload(record: DurableEventRecord): DurableEventRecord['payload'] {
  return JSON.parse(record.payloadJson) as DurableEventRecord['payload'];
}

function cloneRecord<T extends DurableEventRecord>(record: T): T {
  return { ...record, payload: clonePayload(record) };
}

function cloneState(state: MemoryDurableEventOutboxState): MemoryDurableEventOutboxState {
  return {
    events: new Map([...state.events].map(([id, event]) => [id, cloneRecord(event)])),
    seals: new Map([...state.seals].map(([key, seal]) => [key, { ...seal }])),
    checkpoints: new Map(state.checkpoints),
  };
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DurableEventValidationError(`${name} must be a positive safe integer`);
  }
}

function validateLimits(limits: DurableEventStorageLimits): void {
  assertPositiveLimit(limits.maxEventRows, 'maxEventRows');
  assertPositiveLimit(limits.maxRevisionSeals, 'maxRevisionSeals');
  assertPositiveLimit(limits.maxStreams, 'maxStreams');
  assertPositiveLimit(limits.maxPayloadBytes, 'maxPayloadBytes');
}

function clearLease(record: DurableEventRecord): DurableEventRecord {
  const {
    leaseOwner: _leaseOwner,
    leaseToken: _leaseToken,
    leaseExpiresAt: _leaseExpiresAt,
    ...withoutLease
  } = record;
  return withoutLease;
}

function isCurrentClaim(record: DurableEventRecord | undefined, claim: ClaimIdentity): boolean {
  return record?.status === 'pending' && record.leaseToken === claim.leaseToken;
}

function compareClaimOrder(left: DurableEventRecord, right: DurableEventRecord): number {
  return (
    left.availableAt - right.availableAt ||
    left.occurredAt - right.occurredAt ||
    left.createdAt - right.createdAt ||
    compareText(left.id, right.id)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A transaction-scoped in-memory outbox repository.
 *
 * This class does not own a root transaction. A host transaction mechanism can clone this explicit
 * state and replace it only after the complete local transaction commits.
 */
export class MemoryDurableEventOutboxRepository implements DurableEventOutboxRepository {
  private state: MemoryDurableEventOutboxState;
  private readonly limits: DurableEventStorageLimits;
  private stateVersion = 0;
  private baseVersion: number | null = null;

  constructor(options: { limits?: DurableEventStorageLimits } = {}) {
    this.limits = { ...(options.limits ?? DEFAULT_DURABLE_EVENT_STORAGE_LIMITS) };
    validateLimits(this.limits);
    this.state = { events: new Map(), seals: new Map(), checkpoints: new Map() };
  }

  /** Creates an explicit copy for host-owned transaction staging. */
  clone(): MemoryDurableEventOutboxRepository {
    const copy = new MemoryDurableEventOutboxRepository({ limits: this.limits });
    copy.state = cloneState(this.state);
    copy.stateVersion = this.stateVersion;
    copy.baseVersion = this.stateVersion;
    return copy;
  }

  /** Replaces state after the host transaction commits. */
  replaceWith(committed: MemoryDurableEventOutboxRepository): void {
    if (committed === this) return;
    if (committed.baseVersion === null || committed.baseVersion !== this.stateVersion) {
      throw new DurableEventTransactionConflictError(
        'Memory outbox state changed after the host transaction snapshot',
      );
    }
    if (
      committed.limits.maxEventRows !== this.limits.maxEventRows ||
      committed.limits.maxRevisionSeals !== this.limits.maxRevisionSeals ||
      committed.limits.maxStreams !== this.limits.maxStreams ||
      committed.limits.maxPayloadBytes !== this.limits.maxPayloadBytes
    ) {
      throw new DurableEventInvariantError(
        'Cannot commit memory outbox state with different limits',
      );
    }
    this.state = cloneState(committed.state);
    this.stateVersion += 1;
  }

  async enqueueRevision(
    batch: DurableEventRevisionBatch,
    now: number,
  ): Promise<EnqueueDurableEventResult> {
    const prepared = prepareDurableEventRevisionBatch(batch, now);
    const checkpoint = this.state.checkpoints.get(batch.streamId);
    if (checkpoint !== undefined && batch.streamRevision <= checkpoint) {
      throw new DurableEventRevisionAlreadyCompactedError(batch.streamId, batch.streamRevision);
    }
    if (
      checkpoint !== undefined &&
      (batch.expectedPreviousRevision === null || batch.expectedPreviousRevision < checkpoint)
    ) {
      throw new DurableEventBatchConflictError(
        'Expected previous revision is older than the stream checkpoint',
      );
    }

    const key = sealKey(batch.streamId, batch.streamRevision);
    const existingSeal = this.state.seals.get(key);
    if (existingSeal) {
      if (
        existingSeal.expectedPreviousRevision !== prepared.seal.expectedPreviousRevision ||
        existingSeal.eventCount !== prepared.seal.eventCount ||
        existingSeal.eventSetHash !== prepared.seal.eventSetHash
      ) {
        throw new DurableEventBatchConflictError(
          `Durable event revision ${batch.streamRevision} has a different sealed batch`,
        );
      }
      const existingEvents = this.eventsForRevision(batch.streamId, batch.streamRevision);
      if (existingEvents.length !== existingSeal.eventCount) {
        throw new DurableEventInvariantError('Durable event seal count does not match stored rows');
      }
      return { outcome: 'existing', eventIds: existingEvents.map((event) => event.id) };
    }

    const tail = this.greatestSealRevision(batch.streamId);
    if (tail !== null && batch.streamRevision < tail) {
      throw new DurableEventBatchConflictError(
        'Durable event revision is older than the seal tail',
      );
    }
    if (
      tail !== null &&
      batch.expectedPreviousRevision !== null &&
      batch.expectedPreviousRevision < tail
    ) {
      throw new DurableEventBatchConflictError(
        'Expected previous revision is older than the seal tail',
      );
    }

    for (const event of prepared.events) {
      if (this.state.events.has(event.id)) {
        throw new DurableEventBatchConflictError(`Durable event id ${event.id} already exists`);
      }
    }

    const firstStreamRecord = checkpoint === undefined;
    const stats = this.currentStats();
    this.assertCapacity({
      eventRows: stats.eventRows + prepared.events.length,
      revisionSeals: stats.revisionSeals + 1,
      streams: stats.streams + (firstStreamRecord ? 1 : 0),
      payloadBytes:
        stats.payloadBytes + prepared.events.reduce((sum, event) => sum + event.payloadBytes, 0),
    });

    if (firstStreamRecord) {
      this.state.checkpoints.set(batch.streamId, batch.expectedPreviousRevision ?? -1);
    }
    this.state.seals.set(key, prepared.seal);
    for (const event of prepared.events) {
      this.state.events.set(event.id, {
        ...event,
        status: 'pending',
        createdAt: now,
        availableAt: now,
        claimCount: 0,
        failureCount: 0,
        totalFailureCount: 0,
        requeueCount: 0,
      });
    }
    this.stateVersion += 1;
    return { outcome: 'inserted', eventIds: prepared.events.map((event) => event.id) };
  }

  async claimNext(options: DurableEventClaimOptions): Promise<ClaimedDurableEvent | null> {
    assertDurableEventOpaqueIdentifier(options.workerId, 'worker id');
    assertDurableEventOpaqueIdentifier(options.leaseToken, 'lease token');
    assertDurableEventTimestamp(options.now, 'claim time');
    assertPositiveLimit(options.leaseDurationMs, 'leaseDurationMs');
    if (options.contracts.length === 0) return null;
    const contractKeys = new Set(
      options.contracts.map((contract) => {
        assertDurableEventContract(contract);
        return durableEventContractKey(contract);
      }),
    );
    const candidate = [...this.state.events.values()]
      .filter(
        (event) =>
          event.status === 'pending' &&
          event.availableAt <= options.now &&
          (event.leaseExpiresAt === undefined || event.leaseExpiresAt <= options.now) &&
          contractKeys.has(durableEventContractKey(event)),
      )
      .sort(compareClaimOrder)[0];
    if (!candidate) return null;

    const leaseExpiresAt = Math.min(Number.MAX_SAFE_INTEGER, options.now + options.leaseDurationMs);
    const claimed: ClaimedDurableEvent = {
      ...candidate,
      status: 'pending',
      claimCount: candidate.claimCount + 1,
      lastAttemptAt: options.now,
      leaseOwner: options.workerId,
      leaseToken: options.leaseToken,
      leaseExpiresAt,
    };
    this.state.events.set(claimed.id, claimed);
    this.stateVersion += 1;
    return cloneRecord(claimed);
  }

  async readAndValidateCurrentClaim(claim: ClaimIdentity): Promise<ClaimedDurableEvent | null> {
    const event = this.state.events.get(claim.id);
    if (!isCurrentClaim(event, claim)) return null;
    return cloneRecord(event as ClaimedDurableEvent);
  }

  async markPublished(
    id: string,
    leaseToken: string,
    now: number,
  ): Promise<DurableEventClaimMutationResult> {
    assertDurableEventTimestamp(now, 'publication time');
    const event = this.state.events.get(id);
    if (!isCurrentClaim(event, { id, leaseToken })) return 'stale';
    this.state.events.set(id, {
      ...clearLease(event!),
      status: 'published',
      publishedAt: now,
      failureCount: 0,
    });
    this.stateVersion += 1;
    return 'updated';
  }

  async reschedule(
    claim: ClaimIdentity,
    failure: SafeDurableEventFailure,
    availableAt: number,
  ): Promise<DurableEventClaimMutationResult> {
    assertSafeDurableEventFailure(failure);
    assertDurableEventTimestamp(availableAt, 'availableAt');
    const event = this.state.events.get(claim.id);
    if (!isCurrentClaim(event, claim)) return 'stale';
    this.state.events.set(claim.id, {
      ...clearLease(event!),
      status: 'pending',
      availableAt,
      failureCount: event!.failureCount + 1,
      totalFailureCount: event!.totalFailureCount + 1,
      lastErrorCode: failure.code,
      safeErrorMessage: failure.message,
    });
    this.stateVersion += 1;
    return 'updated';
  }

  async block(
    claim: ClaimIdentity,
    failure: SafeDurableEventFailure,
    now: number,
  ): Promise<DurableEventClaimMutationResult> {
    assertSafeDurableEventFailure(failure);
    assertDurableEventTimestamp(now, 'blocked time');
    const event = this.state.events.get(claim.id);
    if (!isCurrentClaim(event, claim)) return 'stale';
    this.state.events.set(claim.id, {
      ...clearLease(event!),
      status: 'blocked',
      failureCount: event!.failureCount + 1,
      totalFailureCount: event!.totalFailureCount + 1,
      lastErrorCode: failure.code,
      safeErrorMessage: failure.message,
      blockedAt: now,
    });
    this.stateVersion += 1;
    return 'updated';
  }

  async requeueBlocked(options: RequeueBlockedDurableEventOptions): Promise<number> {
    assertDurableEventContract(options.contract);
    assertDurableEventTimestamp(options.now, 'requeue time');
    assertPositiveLimit(options.limit, 'requeue limit');
    const key = durableEventContractKey(options.contract);
    const selected = [...this.state.events.values()]
      .filter((event) => event.status === 'blocked' && durableEventContractKey(event) === key)
      .sort(
        (left, right) =>
          (left.blockedAt ?? left.createdAt) - (right.blockedAt ?? right.createdAt) ||
          compareText(left.id, right.id),
      )
      .slice(0, options.limit);
    for (const event of selected) {
      const { blockedAt: _blockedAt, ...withoutBlockedAt } = clearLease(event);
      this.state.events.set(event.id, {
        ...withoutBlockedAt,
        status: 'pending',
        availableAt: options.now,
        failureCount: 0,
        requeueCount: event.requeueCount + 1,
      });
    }
    if (selected.length > 0) this.stateVersion += 1;
    return selected.length;
  }

  async compactPublishedThrough(
    options: CompactDurableEventStreamOptions,
  ): Promise<CompactDurableEventResult> {
    assertDurableEventOpaqueIdentifier(options.streamId, 'stream id');
    assertDurableEventTimestamp(options.throughRevision, 'through revision');
    assertDurableEventTimestamp(options.retentionCutoff, 'retention cutoff');
    assertDurableEventTimestamp(options.now, 'compaction time');
    if (options.retentionCutoff > options.now) {
      throw new DurableEventValidationError('retention cutoff must not be after compaction time');
    }
    const checkpoint = this.state.checkpoints.get(options.streamId);
    if (checkpoint === undefined) {
      throw new DurableEventInvariantError('Cannot compact an unknown durable event stream');
    }
    if (options.throughRevision <= checkpoint) {
      return {
        compactedThroughRevision: checkpoint,
        deletedEventRows: 0,
        deletedRevisionSeals: 0,
      };
    }

    const seals = [...this.state.seals.values()].filter(
      (seal) =>
        seal.streamId === options.streamId &&
        seal.streamRevision > checkpoint &&
        seal.streamRevision <= options.throughRevision,
    );
    const eventIds: string[] = [];
    for (const seal of seals) {
      if (seal.sealedAt > options.retentionCutoff) {
        throw new DurableEventInvariantError(
          'Durable event revision is inside the retention period',
        );
      }
      const events = this.eventsForRevision(seal.streamId, seal.streamRevision);
      if (events.length !== seal.eventCount) {
        throw new DurableEventInvariantError('Durable event seal count does not match stored rows');
      }
      if (
        events.some(
          (event) =>
            event.status !== 'published' ||
            event.publishedAt === undefined ||
            event.publishedAt > options.retentionCutoff,
        )
      ) {
        throw new DurableEventInvariantError(
          'Durable event revision has outstanding retained work',
        );
      }
      const verified = prepareDurableEventRevisionBatch(
        {
          streamId: seal.streamId,
          expectedPreviousRevision: seal.expectedPreviousRevision,
          streamRevision: seal.streamRevision,
          events,
        },
        seal.sealedAt,
      );
      if (
        verified.seal.eventCount !== seal.eventCount ||
        verified.seal.eventSetHash !== seal.eventSetHash
      ) {
        throw new DurableEventInvariantError(
          'Durable event revision seal does not match stored rows',
        );
      }
      eventIds.push(...events.map((event) => event.id));
    }

    for (const id of eventIds) this.state.events.delete(id);
    for (const seal of seals) this.state.seals.delete(sealKey(seal.streamId, seal.streamRevision));
    this.state.checkpoints.set(options.streamId, options.throughRevision);
    this.stateVersion += 1;
    return {
      compactedThroughRevision: options.throughRevision,
      deletedEventRows: eventIds.length,
      deletedRevisionSeals: seals.length,
    };
  }

  async getStorageStats(): Promise<DurableEventStorageStats> {
    return { ...this.currentStats(), limits: { ...this.limits } };
  }

  async listOutstandingContracts(): Promise<readonly OutstandingDurableEventContract[]> {
    const groups = new Map<string, OutstandingDurableEventContract>();
    for (const event of this.state.events.values()) {
      if (event.status === 'published') continue;
      const contract: DurableEventContract = {
        consumerId: event.consumerId,
        eventType: event.eventType,
        envelopeVersion: event.envelopeVersion,
        payloadVersion: event.payloadVersion,
      };
      const key = `${durableEventContractKey(contract)}\u0000${event.status}`;
      const existing = groups.get(key);
      groups.set(key, {
        ...contract,
        status: event.status,
        count: (existing?.count ?? 0) + 1,
        oldestCreatedAt: Math.min(existing?.oldestCreatedAt ?? event.createdAt, event.createdAt),
      });
    }
    return [...groups.values()].sort(
      (left, right) =>
        compareText(left.consumerId, right.consumerId) ||
        compareText(left.eventType, right.eventType) ||
        left.payloadVersion - right.payloadVersion ||
        compareText(left.status, right.status),
    );
  }

  private currentStats(): Omit<DurableEventStorageStats, 'limits'> {
    return {
      eventRows: this.state.events.size,
      revisionSeals: this.state.seals.size,
      streams: this.state.checkpoints.size,
      payloadBytes: [...this.state.events.values()].reduce(
        (sum, event) => sum + event.payloadBytes,
        0,
      ),
    };
  }

  private assertCapacity(projected: Omit<DurableEventStorageStats, 'limits'>): void {
    if (
      projected.eventRows > this.limits.maxEventRows ||
      projected.revisionSeals > this.limits.maxRevisionSeals ||
      projected.streams > this.limits.maxStreams ||
      projected.payloadBytes > this.limits.maxPayloadBytes
    ) {
      throw new DurableEventCapacityExceededError('Durable event outbox capacity is exhausted');
    }
  }

  private greatestSealRevision(streamId: string): number | null {
    let greatest: number | null = null;
    for (const seal of this.state.seals.values()) {
      if (seal.streamId !== streamId) continue;
      if (greatest === null || seal.streamRevision > greatest) greatest = seal.streamRevision;
    }
    return greatest;
  }

  private eventsForRevision(streamId: string, streamRevision: number): DurableEventRecord[] {
    return [...this.state.events.values()]
      .filter((event) => event.streamId === streamId && event.streamRevision === streamRevision)
      .sort((left, right) => compareText(left.id, right.id));
  }
}
