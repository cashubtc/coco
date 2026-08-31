import Dexie, { type Transaction } from 'dexie';
import {
  DEFAULT_DURABLE_EVENT_STORAGE_LIMITS,
  DurableEventBatchConflictError,
  DurableEventCapacityExceededError,
  DurableEventCorruptRecordError,
  DurableEventInvariantError,
  DurableEventRevisionAlreadyCompactedError,
  DurableEventValidationError,
  MAX_DURABLE_EVENT_CLAIM_CONTRACTS,
  addDurableEventDelay,
  assertClaimedDurableEventIntegrity,
  assertDurableEventContract,
  assertDurableEventOpaqueIdentifier,
  assertDurableEventTimestamp,
  assertSafeDurableEventFailure,
  durableEventContractKey,
  prepareDurableEventRevisionBatch,
  type ClaimIdentity,
  type ClaimedDurableEvent,
  type CompactDurableEventResult,
  type CompactDurableEventStreamOptions,
  type DurableEventClaimMutationResult,
  type DurableEventClaimOptions,
  type DurableEventContract,
  type DurableEventOutboxRepository,
  type DurableEventRecord,
  type DurableEventRevisionBatch,
  type DurableEventRevisionSeal,
  type DurableEventStorageLimits,
  type DurableEventStorageStats,
  type EnqueueDurableEventResult,
  type JsonObject,
  type OutstandingDurableEventContract,
  type RequeueBlockedDurableEventOptions,
  type SafeDurableEventFailure,
} from '@cashu/coco-core/adapter';

export const IDB_DURABLE_EVENT_OUTBOX_STORES = Object.freeze([
  'coco_cashu_event_outbox',
  'coco_cashu_event_outbox_revisions',
  'coco_cashu_event_outbox_stream_checkpoints',
  'coco_cashu_event_outbox_storage_stats',
] as const);

const EVENT_STORE = IDB_DURABLE_EVENT_OUTBOX_STORES[0];
const REVISION_STORE = IDB_DURABLE_EVENT_OUTBOX_STORES[1];
const CHECKPOINT_STORE = IDB_DURABLE_EVENT_OUTBOX_STORES[2];
const STATS_STORE = IDB_DURABLE_EVENT_OUTBOX_STORES[3];

type Mutable<T> = { -readonly [Property in keyof T]: T[Property] };

type EventRow = Mutable<Omit<DurableEventRecord, 'payload'>>;

interface RevisionRow extends DurableEventRevisionSeal {}

interface CheckpointRow {
  streamId: string;
  compactedThroughRevision: number;
  updatedAt: number;
}

type StorageStatsRow = Mutable<DurableEventStorageStats> & {
  id: 'v1';
  policyVersion: 1;
};

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DurableEventValidationError(`${name} must be a positive safe integer`);
  }
}

export function validateIdbDurableEventStorageLimits(limits: DurableEventStorageLimits): void {
  assertPositiveSafeInteger(limits.maxEventRows, 'maxEventRows');
  assertPositiveSafeInteger(limits.maxRevisionSeals, 'maxRevisionSeals');
  assertPositiveSafeInteger(limits.maxStreams, 'maxStreams');
  assertPositiveSafeInteger(limits.maxPayloadBytes, 'maxPayloadBytes');
}

export function createIdbDurableEventStorageStats(
  limits: DurableEventStorageLimits = DEFAULT_DURABLE_EVENT_STORAGE_LIMITS,
): StorageStatsRow {
  validateIdbDurableEventStorageLimits(limits);
  return {
    id: 'v1',
    policyVersion: 1,
    eventRows: 0,
    revisionSeals: 0,
    streams: 0,
    payloadBytes: 0,
    limits: { ...limits },
  };
}

function parsePayload(id: string, payloadJson: string): JsonObject {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
      throw new Error('payload is not an object');
    }
    return payload as JsonObject;
  } catch {
    throw new DurableEventCorruptRecordError(id, 'Durable event payload JSON is invalid');
  }
}

function hydrateEvent(row: EventRow): DurableEventRecord {
  return { ...row, payload: parsePayload(row.id, row.payloadJson) };
}

function hydrateClaim(row: EventRow): ClaimedDurableEvent {
  const event = hydrateEvent(row);
  if (
    event.status !== 'pending' ||
    event.leaseOwner === undefined ||
    event.leaseToken === undefined ||
    event.leaseExpiresAt === undefined
  ) {
    throw new DurableEventInvariantError('Claimed durable event has incomplete lease state');
  }
  return event as ClaimedDurableEvent;
}

function clearLease(row: EventRow): void {
  delete row.leaseOwner;
  delete row.leaseToken;
  delete row.leaseExpiresAt;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ConstraintError') return true;
  if (error.name !== 'BulkError' || !('failures' in error)) return false;
  const failures = error.failures;
  return Array.isArray(failures) && failures.length > 0 && failures.every(isConstraintError);
}

function assertCapacity(
  stats: StorageStatsRow,
  projected: Omit<DurableEventStorageStats, 'limits'>,
) {
  if (
    projected.eventRows > stats.limits.maxEventRows ||
    projected.revisionSeals > stats.limits.maxRevisionSeals ||
    projected.streams > stats.limits.maxStreams ||
    projected.payloadBytes > stats.limits.maxPayloadBytes
  ) {
    throw new DurableEventCapacityExceededError('Durable event outbox capacity is exhausted');
  }
}

/**
 * Durable event storage bound to an existing Dexie transaction.
 *
 * The caller must open the transaction with every store in `IDB_DURABLE_EVENT_OUTBOX_STORES`.
 * This repository never opens a root transaction and never retries transaction conflicts.
 */
export class IdbDurableEventOutboxRepository implements DurableEventOutboxRepository {
  constructor(private readonly transaction: Transaction) {}

  private async stats(): Promise<StorageStatsRow> {
    const stats = (await this.transaction.table(STATS_STORE).get('v1')) as
      | StorageStatsRow
      | undefined;
    if (!stats || stats.policyVersion !== 1) {
      throw new DurableEventInvariantError(
        'Durable event storage policy is missing or unsupported',
      );
    }
    validateIdbDurableEventStorageLimits(stats.limits);
    return stats;
  }

  private async eventsForRevision(streamId: string, streamRevision: number): Promise<EventRow[]> {
    return (await this.transaction
      .table(EVENT_STORE)
      .where('[streamId+streamRevision]')
      .equals([streamId, streamRevision])
      .sortBy('id')) as EventRow[];
  }

  async enqueueRevision(
    batch: DurableEventRevisionBatch,
    now: number,
  ): Promise<EnqueueDurableEventResult> {
    const prepared = prepareDurableEventRevisionBatch(batch, now);
    const checkpointTable = this.transaction.table(CHECKPOINT_STORE);
    const revisionTable = this.transaction.table(REVISION_STORE);
    const eventTable = this.transaction.table(EVENT_STORE);
    const statsTable = this.transaction.table(STATS_STORE);
    const checkpoint = (await checkpointTable.get(batch.streamId)) as CheckpointRow | undefined;

    if (checkpoint && batch.streamRevision <= checkpoint.compactedThroughRevision) {
      throw new DurableEventRevisionAlreadyCompactedError(batch.streamId, batch.streamRevision);
    }
    if (
      checkpoint &&
      (batch.expectedPreviousRevision === null ||
        batch.expectedPreviousRevision < checkpoint.compactedThroughRevision)
    ) {
      throw new DurableEventBatchConflictError(
        'Expected previous revision is older than the stream checkpoint',
      );
    }

    const existingSeal = (await revisionTable.get([batch.streamId, batch.streamRevision])) as
      | RevisionRow
      | undefined;
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
      const existingRows = await this.eventsForRevision(batch.streamId, batch.streamRevision);
      if (existingRows.length !== existingSeal.eventCount) {
        throw new DurableEventInvariantError('Durable event seal count does not match stored rows');
      }
      const verified = prepareDurableEventRevisionBatch(
        {
          streamId: existingSeal.streamId,
          expectedPreviousRevision: existingSeal.expectedPreviousRevision,
          streamRevision: existingSeal.streamRevision,
          events: existingRows.map(hydrateEvent),
        },
        existingSeal.sealedAt,
      );
      if (verified.seal.eventSetHash !== existingSeal.eventSetHash) {
        throw new DurableEventInvariantError('Durable event seal does not match stored rows');
      }
      return { outcome: 'existing', eventIds: existingRows.map((event) => event.id) };
    }

    const revisions = (await revisionTable
      .where('streamId')
      .equals(batch.streamId)
      .toArray()) as RevisionRow[];
    const tail = revisions.reduce<number | null>(
      (greatest, revision) =>
        greatest === null || revision.streamRevision > greatest
          ? revision.streamRevision
          : greatest,
      null,
    );
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

    const stats = await this.stats();
    const firstStreamRecord = checkpoint === undefined;
    const payloadBytes = prepared.events.reduce((sum, event) => sum + event.payloadBytes, 0);
    const projected = {
      eventRows: stats.eventRows + prepared.events.length,
      revisionSeals: stats.revisionSeals + 1,
      streams: stats.streams + (firstStreamRecord ? 1 : 0),
      payloadBytes: stats.payloadBytes + payloadBytes,
    };
    assertCapacity(stats, projected);

    try {
      if (firstStreamRecord) {
        await checkpointTable.add({
          streamId: batch.streamId,
          compactedThroughRevision: batch.expectedPreviousRevision ?? -1,
          updatedAt: now,
        } satisfies CheckpointRow);
      }
      await revisionTable.add({ ...prepared.seal } satisfies RevisionRow);
      await eventTable.bulkAdd(
        prepared.events.map(
          ({ payload: _payload, ...event }): EventRow => ({
            ...event,
            status: 'pending',
            createdAt: now,
            availableAt: now,
            claimCount: 0,
            failureCount: 0,
            totalFailureCount: 0,
            requeueCount: 0,
          }),
        ),
      );
      await statsTable.put({ ...stats, ...projected });
    } catch (error) {
      if (isConstraintError(error)) {
        throw new DurableEventBatchConflictError('Durable event batch conflicts with stored data');
      }
      throw error;
    }
    return { outcome: 'inserted', eventIds: prepared.events.map((event) => event.id) };
  }

  async claimNext(options: DurableEventClaimOptions): Promise<ClaimedDurableEvent | null> {
    assertDurableEventOpaqueIdentifier(options.workerId, 'worker id');
    assertDurableEventOpaqueIdentifier(options.leaseToken, 'lease token');
    assertDurableEventTimestamp(options.now, 'claim time');
    assertPositiveSafeInteger(options.leaseDurationMs, 'leaseDurationMs');
    if (options.contracts.length === 0) return null;
    if (options.contracts.length > MAX_DURABLE_EVENT_CLAIM_CONTRACTS) {
      throw new DurableEventValidationError(
        `claim contracts must not contain more than ${MAX_DURABLE_EVENT_CLAIM_CONTRACTS} items`,
      );
    }
    const contracts = new Set<string>();
    for (const contract of options.contracts) {
      assertDurableEventContract(contract);
      contracts.add(durableEventContractKey(contract));
    }
    const eventTable = this.transaction.table(EVENT_STORE);
    while (true) {
      const candidate = (await eventTable
        .where('[status+availableAt+occurredAt+createdAt+id]')
        .between(
          ['pending', Dexie.minKey, Dexie.minKey, Dexie.minKey, Dexie.minKey],
          ['pending', options.now, Dexie.maxKey, Dexie.maxKey, Dexie.maxKey],
          true,
          true,
        )
        .filter(
          (event: EventRow) =>
            contracts.has(durableEventContractKey(event)) &&
            (event.leaseToken === undefined || (event.leaseExpiresAt ?? 0) <= options.now),
        )
        .first()) as EventRow | undefined;
      if (!candidate) return null;

      const current = (await eventTable.get(candidate.id)) as EventRow | undefined;
      if (
        !current ||
        current.status !== 'pending' ||
        current.availableAt > options.now ||
        (current.leaseToken !== undefined && (current.leaseExpiresAt ?? 0) > options.now)
      ) {
        continue;
      }
      current.leaseOwner = options.workerId;
      current.leaseToken = options.leaseToken;
      current.leaseExpiresAt = addDurableEventDelay(options.now, options.leaseDurationMs);
      current.claimCount += 1;
      current.lastAttemptAt = options.now;
      let claim: ClaimedDurableEvent;
      try {
        claim = hydrateClaim(current);
        assertClaimedDurableEventIntegrity(claim);
      } catch (error) {
        if (!(error instanceof DurableEventCorruptRecordError)) throw error;
        current.status = 'blocked';
        current.blockedAt = options.now;
        current.failureCount += 1;
        current.totalFailureCount += 1;
        current.lastErrorCode = 'outbox.corrupt_record';
        delete current.safeErrorMessage;
        clearLease(current);
        await eventTable.put(current);
        continue;
      }
      await eventTable.put(current);
      return claim;
    }
  }

  async readAndValidateCurrentClaim(claim: ClaimIdentity): Promise<ClaimedDurableEvent | null> {
    const row = (await this.transaction.table(EVENT_STORE).get(claim.id)) as EventRow | undefined;
    if (!row || row.status !== 'pending' || row.leaseToken !== claim.leaseToken) return null;
    const event = hydrateClaim(row);
    assertClaimedDurableEventIntegrity(event);
    return event;
  }

  async markPublished(
    id: string,
    leaseToken: string,
    now: number,
  ): Promise<DurableEventClaimMutationResult> {
    assertDurableEventTimestamp(now, 'publication time');
    const row = (await this.transaction.table(EVENT_STORE).get(id)) as EventRow | undefined;
    if (!row || row.status !== 'pending' || row.leaseToken !== leaseToken) return 'stale';
    row.status = 'published';
    row.publishedAt = now;
    row.failureCount = 0;
    clearLease(row);
    await this.transaction.table(EVENT_STORE).put(row);
    return 'updated';
  }

  async reschedule(
    claim: ClaimIdentity,
    failure: SafeDurableEventFailure,
    availableAt: number,
  ): Promise<DurableEventClaimMutationResult> {
    assertSafeDurableEventFailure(failure);
    assertDurableEventTimestamp(availableAt, 'availableAt');
    const row = (await this.transaction.table(EVENT_STORE).get(claim.id)) as EventRow | undefined;
    if (!row || row.status !== 'pending' || row.leaseToken !== claim.leaseToken) return 'stale';
    row.availableAt = availableAt;
    row.failureCount += 1;
    row.totalFailureCount += 1;
    row.lastErrorCode = failure.code;
    if (failure.message === undefined) delete row.safeErrorMessage;
    else row.safeErrorMessage = failure.message;
    clearLease(row);
    await this.transaction.table(EVENT_STORE).put(row);
    return 'updated';
  }

  async block(
    claim: ClaimIdentity,
    failure: SafeDurableEventFailure,
    now: number,
  ): Promise<DurableEventClaimMutationResult> {
    assertSafeDurableEventFailure(failure);
    assertDurableEventTimestamp(now, 'blocked time');
    const row = (await this.transaction.table(EVENT_STORE).get(claim.id)) as EventRow | undefined;
    if (!row || row.status !== 'pending' || row.leaseToken !== claim.leaseToken) return 'stale';
    row.status = 'blocked';
    row.blockedAt = now;
    row.failureCount += 1;
    row.totalFailureCount += 1;
    row.lastErrorCode = failure.code;
    if (failure.message === undefined) delete row.safeErrorMessage;
    else row.safeErrorMessage = failure.message;
    clearLease(row);
    await this.transaction.table(EVENT_STORE).put(row);
    return 'updated';
  }

  async requeueBlocked(options: RequeueBlockedDurableEventOptions): Promise<number> {
    assertDurableEventContract(options.contract);
    assertPositiveSafeInteger(options.limit, 'requeue limit');
    assertDurableEventTimestamp(options.now, 'requeue time');
    const rows = (
      (await this.transaction
        .table(EVENT_STORE)
        .where('status')
        .equals('blocked')
        .toArray()) as EventRow[]
    )
      .filter((row) => durableEventContractKey(row) === durableEventContractKey(options.contract))
      .sort(
        (left, right) =>
          (left.blockedAt ?? 0) - (right.blockedAt ?? 0) ||
          left.createdAt - right.createdAt ||
          compareText(left.id, right.id),
      )
      .slice(0, options.limit);
    for (const row of rows) {
      row.status = 'pending';
      row.availableAt = options.now;
      row.failureCount = 0;
      row.requeueCount += 1;
      delete row.blockedAt;
      clearLease(row);
    }
    await this.transaction.table(EVENT_STORE).bulkPut(rows);
    return rows.length;
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
    const checkpointTable = this.transaction.table(CHECKPOINT_STORE);
    const revisionTable = this.transaction.table(REVISION_STORE);
    const eventTable = this.transaction.table(EVENT_STORE);
    const statsTable = this.transaction.table(STATS_STORE);
    const checkpoint = (await checkpointTable.get(options.streamId)) as CheckpointRow | undefined;
    if (!checkpoint)
      throw new DurableEventInvariantError('Cannot compact an unknown durable event stream');
    if (options.throughRevision <= checkpoint.compactedThroughRevision) {
      return {
        compactedThroughRevision: checkpoint.compactedThroughRevision,
        deletedEventRows: 0,
        deletedRevisionSeals: 0,
      };
    }

    const revisions = (
      (await revisionTable.where('streamId').equals(options.streamId).toArray()) as RevisionRow[]
    )
      .filter(
        (revision) =>
          revision.streamRevision > checkpoint.compactedThroughRevision &&
          revision.streamRevision <= options.throughRevision,
      )
      .sort((left, right) => left.streamRevision - right.streamRevision);
    const rowsToDelete: EventRow[] = [];
    for (const revision of revisions) {
      if (revision.sealedAt > options.retentionCutoff) {
        throw new DurableEventInvariantError(
          'Durable event revision is inside the retention period',
        );
      }
      const rows = await this.eventsForRevision(revision.streamId, revision.streamRevision);
      if (rows.length !== revision.eventCount) {
        throw new DurableEventInvariantError('Durable event seal count does not match stored rows');
      }
      if (
        rows.some(
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
          streamId: revision.streamId,
          expectedPreviousRevision: revision.expectedPreviousRevision,
          streamRevision: revision.streamRevision,
          events: rows.map(hydrateEvent),
        },
        revision.sealedAt,
      );
      if (
        verified.seal.eventCount !== revision.eventCount ||
        verified.seal.eventSetHash !== revision.eventSetHash
      ) {
        throw new DurableEventInvariantError(
          'Durable event revision seal does not match stored rows',
        );
      }
      rowsToDelete.push(...rows);
    }

    await eventTable.bulkDelete(rowsToDelete.map((row) => row.id));
    await revisionTable.bulkDelete(
      revisions.map((revision) => [revision.streamId, revision.streamRevision]),
    );
    checkpoint.compactedThroughRevision = options.throughRevision;
    checkpoint.updatedAt = options.now;
    await checkpointTable.put(checkpoint);
    const stats = await this.stats();
    const deletedPayloadBytes = rowsToDelete.reduce((sum, event) => sum + event.payloadBytes, 0);
    stats.eventRows -= rowsToDelete.length;
    stats.revisionSeals -= revisions.length;
    stats.payloadBytes -= deletedPayloadBytes;
    if (stats.eventRows < 0 || stats.revisionSeals < 0 || stats.payloadBytes < 0) {
      throw new DurableEventInvariantError('Durable event storage counters became negative');
    }
    await statsTable.put(stats);
    return {
      compactedThroughRevision: options.throughRevision,
      deletedEventRows: rowsToDelete.length,
      deletedRevisionSeals: revisions.length,
    };
  }

  async getStorageStats(): Promise<DurableEventStorageStats> {
    const { id: _id, policyVersion: _policyVersion, ...stats } = await this.stats();
    return { ...stats, limits: { ...stats.limits } };
  }

  async listOutstandingContracts(): Promise<readonly OutstandingDurableEventContract[]> {
    const rows = ((await this.transaction.table(EVENT_STORE).toArray()) as EventRow[]).filter(
      (event) => event.status === 'pending' || event.status === 'blocked',
    );
    const groups = new Map<string, OutstandingDurableEventContract>();
    for (const row of rows) {
      if (row.status === 'published') continue;
      const key = `${durableEventContractKey(row)}\u0000${row.status}`;
      const existing = groups.get(key);
      groups.set(key, {
        consumerId: row.consumerId,
        eventType: row.eventType,
        envelopeVersion: row.envelopeVersion,
        payloadVersion: row.payloadVersion,
        status: row.status,
        count: (existing?.count ?? 0) + 1,
        oldestCreatedAt: Math.min(existing?.oldestCreatedAt ?? row.createdAt, row.createdAt),
      });
    }
    return [...groups.values()].sort(
      (left, right) =>
        left.oldestCreatedAt - right.oldestCreatedAt ||
        compareText(durableEventContractKey(left), durableEventContractKey(right)) ||
        compareText(left.status, right.status),
    );
  }
}

export async function configureIdbDurableEventOutboxStorageLimits(
  transaction: Transaction,
  limits: DurableEventStorageLimits,
): Promise<void> {
  validateIdbDurableEventStorageLimits(limits);
  const repository = new IdbDurableEventOutboxRepository(transaction);
  const current = await repository.getStorageStats();
  if (
    current.eventRows > limits.maxEventRows ||
    current.revisionSeals > limits.maxRevisionSeals ||
    current.streams > limits.maxStreams ||
    current.payloadBytes > limits.maxPayloadBytes
  ) {
    throw new DurableEventCapacityExceededError(
      'Durable event outbox limits are below current storage use',
    );
  }
  await transaction.table(STATS_STORE).put({
    id: 'v1',
    policyVersion: 1,
    eventRows: current.eventRows,
    revisionSeals: current.revisionSeals,
    streams: current.streams,
    payloadBytes: current.payloadBytes,
    limits: { ...limits },
  } satisfies StorageStatsRow);
}
