import {
  DurableEventBatchConflictError,
  DurableEventCapacityExceededError,
  DurableEventCorruptRecordError,
  DurableEventInvariantError,
  DurableEventRevisionAlreadyCompactedError,
  DurableEventValidationError,
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
  type DurableEventStorageLimits,
  type DurableEventStorageStats,
  type EnqueueDurableEventResult,
  type JsonObject,
  type OutstandingDurableEventContract,
  type RequeueBlockedDurableEventOptions,
  type SafeDurableEventFailure,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase, SqlParams } from '../index.ts';

interface EventRow {
  id: string;
  envelopeVersion: number;
  eventKey: string;
  eventType: string;
  consumerId: string;
  streamId: string;
  streamRevision: number;
  payloadVersion: number;
  payloadJson: string;
  payloadBytes: number;
  contentHash: string;
  occurredAt: number;
  status: 'pending' | 'published' | 'blocked';
  createdAt: number;
  availableAt: number;
  claimCount: number;
  failureCount: number;
  totalFailureCount: number;
  requeueCount: number;
  lastAttemptAt: number | null;
  lastErrorCode: string | null;
  safeErrorMessage: string | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  publishedAt: number | null;
  blockedAt: number | null;
}

interface RevisionRow {
  streamId: string;
  streamRevision: number;
  expectedPreviousRevision: number | null;
  eventCount: number;
  eventSetHash: string;
  sealedAt: number;
}

interface StorageStatsRow {
  eventRows: number;
  revisionSeals: number;
  streams: number;
  payloadBytes: number;
  maxEventRows: number;
  maxRevisionSeals: number;
  maxStreams: number;
  maxPayloadBytes: number;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DurableEventValidationError(`${name} must be a positive safe integer`);
  }
}

function validateStorageLimits(limits: DurableEventStorageLimits): void {
  assertPositiveSafeInteger(limits.maxEventRows, 'maxEventRows');
  assertPositiveSafeInteger(limits.maxRevisionSeals, 'maxRevisionSeals');
  assertPositiveSafeInteger(limits.maxStreams, 'maxStreams');
  assertPositiveSafeInteger(limits.maxPayloadBytes, 'maxPayloadBytes');
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
  return {
    id: row.id,
    envelopeVersion: row.envelopeVersion,
    eventKey: row.eventKey,
    eventType: row.eventType,
    consumerId: row.consumerId,
    streamId: row.streamId,
    streamRevision: row.streamRevision,
    payloadVersion: row.payloadVersion,
    payload: parsePayload(row.id, row.payloadJson),
    payloadJson: row.payloadJson,
    payloadBytes: row.payloadBytes,
    contentHash: row.contentHash,
    occurredAt: row.occurredAt,
    status: row.status,
    createdAt: row.createdAt,
    availableAt: row.availableAt,
    claimCount: row.claimCount,
    failureCount: row.failureCount,
    totalFailureCount: row.totalFailureCount,
    requeueCount: row.requeueCount,
    lastAttemptAt: row.lastAttemptAt ?? undefined,
    lastErrorCode: row.lastErrorCode ?? undefined,
    safeErrorMessage: row.safeErrorMessage ?? undefined,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseToken: row.leaseToken ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ?? undefined,
    publishedAt: row.publishedAt ?? undefined,
    blockedAt: row.blockedAt ?? undefined,
  };
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

function isCapacityError(error: unknown): boolean {
  return String(error).toLowerCase().includes('durable event outbox capacity exceeded');
}

function rethrowStorageError(error: unknown): never {
  if (isCapacityError(error)) {
    throw new DurableEventCapacityExceededError('Durable event outbox capacity is exhausted');
  }
  throw error;
}

export async function configureDurableEventOutboxStorageLimits(
  database: SqlDatabase,
  limits: DurableEventStorageLimits,
): Promise<void> {
  validateStorageLimits(limits);
  const result = await database.run(
    `UPDATE coco_cashu_event_outbox_storage_stats
     SET maxEventRows = ?, maxRevisionSeals = ?, maxStreams = ?, maxPayloadBytes = ?
     WHERE id = 1
       AND eventRows <= ?
       AND revisionSeals <= ?
       AND streams <= ?
       AND payloadBytes <= ?`,
    [
      limits.maxEventRows,
      limits.maxRevisionSeals,
      limits.maxStreams,
      limits.maxPayloadBytes,
      limits.maxEventRows,
      limits.maxRevisionSeals,
      limits.maxStreams,
      limits.maxPayloadBytes,
    ],
  );
  if (result.changes !== 1) {
    throw new DurableEventCapacityExceededError(
      'Durable event outbox limits are below current storage use',
    );
  }
}

/**
 * Durable event storage bound to the supplied SQL handle.
 *
 * Multi-statement calls require the handle to belong to a caller-owned transaction. This class
 * never opens a root transaction and never retries database conflicts.
 */
export class SqliteDurableEventOutboxRepository implements DurableEventOutboxRepository {
  constructor(private readonly database: SqlDatabase) {}

  async enqueueRevision(
    batch: DurableEventRevisionBatch,
    now: number,
  ): Promise<EnqueueDurableEventResult> {
    const prepared = prepareDurableEventRevisionBatch(batch, now);
    try {
      const checkpoint = await this.database.get<{ compactedThroughRevision: number }>(
        `SELECT compactedThroughRevision
         FROM coco_cashu_event_outbox_stream_checkpoints
         WHERE streamId = ?`,
        [batch.streamId],
      );
      if (checkpoint !== undefined && batch.streamRevision <= checkpoint.compactedThroughRevision) {
        throw new DurableEventRevisionAlreadyCompactedError(batch.streamId, batch.streamRevision);
      }
      if (
        checkpoint !== undefined &&
        (batch.expectedPreviousRevision === null ||
          batch.expectedPreviousRevision < checkpoint.compactedThroughRevision)
      ) {
        throw new DurableEventBatchConflictError(
          'Expected previous revision is older than the stream checkpoint',
        );
      }

      const existingSeal = await this.database.get<RevisionRow>(
        `SELECT streamId, streamRevision, expectedPreviousRevision, eventCount, eventSetHash, sealedAt
         FROM coco_cashu_event_outbox_revisions
         WHERE streamId = ? AND streamRevision = ?`,
        [batch.streamId, batch.streamRevision],
      );
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
        const existingEvents = await this.eventsForRevision(batch.streamId, batch.streamRevision);
        if (existingEvents.length !== existingSeal.eventCount) {
          throw new DurableEventInvariantError(
            'Durable event seal count does not match stored rows',
          );
        }
        const verified = prepareDurableEventRevisionBatch(
          {
            streamId: existingSeal.streamId,
            expectedPreviousRevision: existingSeal.expectedPreviousRevision,
            streamRevision: existingSeal.streamRevision,
            events: existingEvents,
          },
          existingSeal.sealedAt,
        );
        if (verified.seal.eventSetHash !== existingSeal.eventSetHash) {
          throw new DurableEventInvariantError('Durable event seal does not match stored rows');
        }
        return { outcome: 'existing', eventIds: existingEvents.map((event) => event.id) };
      }

      const tail = await this.database.get<{ streamRevision: number | null }>(
        `SELECT MAX(streamRevision) AS streamRevision
         FROM coco_cashu_event_outbox_revisions
         WHERE streamId = ?`,
        [batch.streamId],
      );
      if (tail?.streamRevision !== null && tail?.streamRevision !== undefined) {
        if (batch.streamRevision < tail.streamRevision) {
          throw new DurableEventBatchConflictError(
            'Durable event revision is older than the seal tail',
          );
        }
        if (
          batch.expectedPreviousRevision !== null &&
          batch.expectedPreviousRevision < tail.streamRevision
        ) {
          throw new DurableEventBatchConflictError(
            'Expected previous revision is older than the seal tail',
          );
        }
      }

      if (!checkpoint) {
        await this.database.run(
          `INSERT INTO coco_cashu_event_outbox_stream_checkpoints
            (streamId, compactedThroughRevision, updatedAt)
           VALUES (?, ?, ?)`,
          [batch.streamId, batch.expectedPreviousRevision ?? -1, now],
        );
      }
      await this.database.run(
        `INSERT INTO coco_cashu_event_outbox_revisions
          (streamId, streamRevision, expectedPreviousRevision, eventCount, eventSetHash, sealedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          prepared.seal.streamId,
          prepared.seal.streamRevision,
          prepared.seal.expectedPreviousRevision,
          prepared.seal.eventCount,
          prepared.seal.eventSetHash,
          prepared.seal.sealedAt,
        ],
      );
      for (const event of prepared.events) {
        await this.database.run(
          `INSERT INTO coco_cashu_event_outbox (
            id, envelopeVersion, eventKey, eventType, consumerId, streamId, streamRevision,
            payloadVersion, payloadJson, payloadBytes, contentHash, occurredAt, status,
            createdAt, availableAt, claimCount, failureCount, totalFailureCount, requeueCount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, 0, 0, 0)`,
          [
            event.id,
            event.envelopeVersion,
            event.eventKey,
            event.eventType,
            event.consumerId,
            event.streamId,
            event.streamRevision,
            event.payloadVersion,
            event.payloadJson,
            event.payloadBytes,
            event.contentHash,
            event.occurredAt,
            now,
            now,
          ],
        );
      }
      return { outcome: 'inserted', eventIds: prepared.events.map((event) => event.id) };
    } catch (error) {
      rethrowStorageError(error);
    }
  }

  async claimNext(options: DurableEventClaimOptions): Promise<ClaimedDurableEvent | null> {
    assertDurableEventOpaqueIdentifier(options.workerId, 'worker id');
    assertDurableEventOpaqueIdentifier(options.leaseToken, 'lease token');
    assertDurableEventTimestamp(options.now, 'claim time');
    assertPositiveSafeInteger(options.leaseDurationMs, 'leaseDurationMs');
    if (options.contracts.length === 0) return null;
    if (options.contracts.length > 128) {
      throw new DurableEventValidationError('claim contracts must not contain more than 128 items');
    }
    const uniqueContracts = new Map<string, DurableEventContract>();
    for (const contract of options.contracts) {
      assertDurableEventContract(contract);
      uniqueContracts.set(durableEventContractKey(contract), contract);
    }
    const clauses: string[] = [];
    const contractParams: SqlParams[number][] = [];
    for (const contract of uniqueContracts.values()) {
      clauses.push(
        '(consumerId = ? AND eventType = ? AND envelopeVersion = ? AND payloadVersion = ?)',
      );
      contractParams.push(
        contract.consumerId,
        contract.eventType,
        contract.envelopeVersion,
        contract.payloadVersion,
      );
    }
    const candidate = await this.database.get<{ id: string }>(
      `SELECT id
       FROM coco_cashu_event_outbox
       WHERE status = 'pending'
         AND availableAt <= ?
         AND (leaseToken IS NULL OR leaseExpiresAt <= ?)
         AND (${clauses.join(' OR ')})
       ORDER BY availableAt ASC, occurredAt ASC, createdAt ASC, id ASC
       LIMIT 1`,
      [options.now, options.now, ...contractParams],
    );
    if (!candidate) return null;

    const leaseExpiresAt = addDurableEventDelay(options.now, options.leaseDurationMs);
    const updated = await this.database.run(
      `UPDATE coco_cashu_event_outbox
       SET leaseOwner = ?, leaseToken = ?, leaseExpiresAt = ?,
           claimCount = claimCount + 1, lastAttemptAt = ?
       WHERE id = ?
         AND status = 'pending'
         AND availableAt <= ?
         AND (leaseToken IS NULL OR leaseExpiresAt <= ?)`,
      [
        options.workerId,
        options.leaseToken,
        leaseExpiresAt,
        options.now,
        candidate.id,
        options.now,
        options.now,
      ],
    );
    if (updated.changes !== 1) return null;
    const row = await this.database.get<EventRow>(
      'SELECT * FROM coco_cashu_event_outbox WHERE id = ?',
      [candidate.id],
    );
    if (!row) throw new DurableEventInvariantError('Claimed durable event row disappeared');
    return hydrateClaim(row);
  }

  async readAndValidateCurrentClaim(claim: ClaimIdentity): Promise<ClaimedDurableEvent | null> {
    const row = await this.database.get<EventRow>(
      `SELECT * FROM coco_cashu_event_outbox
       WHERE id = ? AND status = 'pending' AND leaseToken = ?`,
      [claim.id, claim.leaseToken],
    );
    if (!row) return null;
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
    const result = await this.database.run(
      `UPDATE coco_cashu_event_outbox
       SET status = 'published', publishedAt = ?, failureCount = 0,
           leaseOwner = NULL, leaseToken = NULL, leaseExpiresAt = NULL
       WHERE id = ? AND status = 'pending' AND leaseToken = ?`,
      [now, id, leaseToken],
    );
    return result.changes === 1 ? 'updated' : 'stale';
  }

  async reschedule(
    claim: ClaimIdentity,
    failure: SafeDurableEventFailure,
    availableAt: number,
  ): Promise<DurableEventClaimMutationResult> {
    assertSafeDurableEventFailure(failure);
    assertDurableEventTimestamp(availableAt, 'availableAt');
    const result = await this.database.run(
      `UPDATE coco_cashu_event_outbox
       SET availableAt = ?, failureCount = failureCount + 1,
           totalFailureCount = totalFailureCount + 1,
           lastErrorCode = ?, safeErrorMessage = ?,
           leaseOwner = NULL, leaseToken = NULL, leaseExpiresAt = NULL
       WHERE id = ? AND status = 'pending' AND leaseToken = ?`,
      [availableAt, failure.code, failure.message ?? null, claim.id, claim.leaseToken],
    );
    return result.changes === 1 ? 'updated' : 'stale';
  }

  async block(
    claim: ClaimIdentity,
    failure: SafeDurableEventFailure,
    now: number,
  ): Promise<DurableEventClaimMutationResult> {
    assertSafeDurableEventFailure(failure);
    assertDurableEventTimestamp(now, 'blocked time');
    const result = await this.database.run(
      `UPDATE coco_cashu_event_outbox
       SET status = 'blocked', blockedAt = ?,
           failureCount = failureCount + 1, totalFailureCount = totalFailureCount + 1,
           lastErrorCode = ?, safeErrorMessage = ?,
           leaseOwner = NULL, leaseToken = NULL, leaseExpiresAt = NULL
       WHERE id = ? AND status = 'pending' AND leaseToken = ?`,
      [now, failure.code, failure.message ?? null, claim.id, claim.leaseToken],
    );
    return result.changes === 1 ? 'updated' : 'stale';
  }

  async requeueBlocked(options: RequeueBlockedDurableEventOptions): Promise<number> {
    assertDurableEventContract(options.contract);
    assertPositiveSafeInteger(options.limit, 'requeue limit');
    assertDurableEventTimestamp(options.now, 'requeue time');
    const result = await this.database.run(
      `UPDATE coco_cashu_event_outbox
       SET status = 'pending', availableAt = ?, blockedAt = NULL,
           failureCount = 0, requeueCount = requeueCount + 1,
           leaseOwner = NULL, leaseToken = NULL, leaseExpiresAt = NULL
       WHERE id IN (
         SELECT id FROM coco_cashu_event_outbox
         WHERE status = 'blocked'
           AND consumerId = ? AND eventType = ?
           AND envelopeVersion = ? AND payloadVersion = ?
         ORDER BY blockedAt ASC, createdAt ASC, id ASC
         LIMIT ?
       )`,
      [
        options.now,
        options.contract.consumerId,
        options.contract.eventType,
        options.contract.envelopeVersion,
        options.contract.payloadVersion,
        options.limit,
      ],
    );
    return result.changes;
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
    const checkpoint = await this.database.get<{ compactedThroughRevision: number }>(
      `SELECT compactedThroughRevision
       FROM coco_cashu_event_outbox_stream_checkpoints
       WHERE streamId = ?`,
      [options.streamId],
    );
    if (!checkpoint) {
      throw new DurableEventInvariantError('Cannot compact an unknown durable event stream');
    }
    if (options.throughRevision <= checkpoint.compactedThroughRevision) {
      return {
        compactedThroughRevision: checkpoint.compactedThroughRevision,
        deletedEventRows: 0,
        deletedRevisionSeals: 0,
      };
    }

    const revisions = await this.database.all<RevisionRow>(
      `SELECT streamId, streamRevision, expectedPreviousRevision, eventCount, eventSetHash, sealedAt
       FROM coco_cashu_event_outbox_revisions
       WHERE streamId = ? AND streamRevision > ? AND streamRevision <= ?
       ORDER BY streamRevision ASC`,
      [options.streamId, checkpoint.compactedThroughRevision, options.throughRevision],
    );
    for (const revision of revisions) {
      if (revision.sealedAt > options.retentionCutoff) {
        throw new DurableEventInvariantError(
          'Durable event revision is inside the retention period',
        );
      }
      const events = await this.eventsForRevision(revision.streamId, revision.streamRevision);
      if (events.length !== revision.eventCount) {
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
      let verified;
      try {
        verified = prepareDurableEventRevisionBatch(
          {
            streamId: revision.streamId,
            expectedPreviousRevision: revision.expectedPreviousRevision,
            streamRevision: revision.streamRevision,
            events,
          },
          revision.sealedAt,
        );
      } catch (error) {
        throw new DurableEventInvariantError(
          error instanceof Error ? error.message : 'Durable event revision is corrupt',
        );
      }
      if (
        verified.seal.eventCount !== revision.eventCount ||
        verified.seal.eventSetHash !== revision.eventSetHash
      ) {
        throw new DurableEventInvariantError(
          'Durable event revision seal does not match stored rows',
        );
      }
    }

    const deletedEvents = await this.database.all<{ id: string }>(
      `DELETE FROM coco_cashu_event_outbox
       WHERE streamId = ? AND streamRevision > ? AND streamRevision <= ?
       RETURNING id`,
      [options.streamId, checkpoint.compactedThroughRevision, options.throughRevision],
    );
    const deletedRevisions = await this.database.all<{ streamRevision: number }>(
      `DELETE FROM coco_cashu_event_outbox_revisions
       WHERE streamId = ? AND streamRevision > ? AND streamRevision <= ?
       RETURNING streamRevision`,
      [options.streamId, checkpoint.compactedThroughRevision, options.throughRevision],
    );
    const advanced = await this.database.run(
      `UPDATE coco_cashu_event_outbox_stream_checkpoints
       SET compactedThroughRevision = ?, updatedAt = ?
       WHERE streamId = ? AND compactedThroughRevision = ?`,
      [options.throughRevision, options.now, options.streamId, checkpoint.compactedThroughRevision],
    );
    if (advanced.changes !== 1) {
      throw new DurableEventInvariantError('Durable event checkpoint changed during compaction');
    }
    return {
      compactedThroughRevision: options.throughRevision,
      deletedEventRows: deletedEvents.length,
      deletedRevisionSeals: deletedRevisions.length,
    };
  }

  async getStorageStats(): Promise<DurableEventStorageStats> {
    const row = await this.database.get<StorageStatsRow>(
      `SELECT eventRows, revisionSeals, streams, payloadBytes,
              maxEventRows, maxRevisionSeals, maxStreams, maxPayloadBytes
       FROM coco_cashu_event_outbox_storage_stats
       WHERE id = 1`,
    );
    if (!row) throw new DurableEventInvariantError('Durable event storage statistics are missing');
    return {
      eventRows: row.eventRows,
      revisionSeals: row.revisionSeals,
      streams: row.streams,
      payloadBytes: row.payloadBytes,
      limits: {
        maxEventRows: row.maxEventRows,
        maxRevisionSeals: row.maxRevisionSeals,
        maxStreams: row.maxStreams,
        maxPayloadBytes: row.maxPayloadBytes,
      },
    };
  }

  async listOutstandingContracts(): Promise<readonly OutstandingDurableEventContract[]> {
    return this.database.all<OutstandingDurableEventContract>(
      `SELECT consumerId, eventType, envelopeVersion, payloadVersion, status,
              COUNT(*) AS count, MIN(createdAt) AS oldestCreatedAt
       FROM coco_cashu_event_outbox
       WHERE status IN ('pending', 'blocked')
       GROUP BY consumerId, eventType, envelopeVersion, payloadVersion, status
       ORDER BY consumerId, eventType, payloadVersion, status`,
    );
  }

  private async eventsForRevision(
    streamId: string,
    streamRevision: number,
  ): Promise<DurableEventRecord[]> {
    const rows = await this.database.all<EventRow>(
      `SELECT * FROM coco_cashu_event_outbox
       WHERE streamId = ? AND streamRevision = ?
       ORDER BY id ASC`,
      [streamId, streamRevision],
    );
    return rows.map(hydrateEvent);
  }
}
