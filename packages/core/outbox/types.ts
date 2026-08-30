export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface DurableEventContract {
  readonly consumerId: string;
  readonly eventType: string;
  readonly envelopeVersion: number;
  readonly payloadVersion: number;
}

export interface DurableEventIntent extends DurableEventContract {
  readonly id: string;
  readonly eventKey: string;
  readonly streamId: string;
  readonly streamRevision: number;
  readonly payload: JsonObject;
  readonly occurredAt: number;
}

export interface DurableEventRevisionBatch {
  readonly streamId: string;
  readonly expectedPreviousRevision: number | null;
  readonly streamRevision: number;
  readonly events: readonly DurableEventIntent[];
}

export interface PreparedDurableEventIntent extends DurableEventIntent {
  readonly payloadJson: string;
  readonly payloadBytes: number;
  readonly contentHash: string;
}

export interface DurableEventRevisionSeal {
  readonly streamId: string;
  readonly expectedPreviousRevision: number | null;
  readonly streamRevision: number;
  readonly eventCount: number;
  readonly eventSetHash: string;
  readonly sealedAt: number;
}

export interface PreparedDurableEventRevisionBatch {
  readonly events: readonly PreparedDurableEventIntent[];
  readonly seal: DurableEventRevisionSeal;
  readonly canonicalBytes: number;
}

export type DurableEventStatus = 'pending' | 'published' | 'blocked';

export interface DurableEventRecord extends PreparedDurableEventIntent {
  readonly status: DurableEventStatus;
  readonly createdAt: number;
  readonly availableAt: number;
  readonly claimCount: number;
  readonly failureCount: number;
  readonly totalFailureCount: number;
  readonly requeueCount: number;
  readonly lastAttemptAt?: number;
  readonly lastErrorCode?: string;
  readonly safeErrorMessage?: string;
  readonly leaseOwner?: string;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: number;
  readonly publishedAt?: number;
  readonly blockedAt?: number;
}

export interface ClaimIdentity {
  readonly id: string;
  readonly leaseToken: string;
}

export interface ClaimedDurableEvent extends DurableEventRecord {
  readonly status: 'pending';
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
}

export interface SafeDurableEventFailure {
  readonly code: string;
  readonly message?: string;
}

export interface DurableEventStorageLimits {
  readonly maxEventRows: number;
  readonly maxRevisionSeals: number;
  readonly maxStreams: number;
  readonly maxPayloadBytes: number;
}

/** Version-1 hard storage limits. Hosts may configure lower or higher finite limits explicitly. */
export const DEFAULT_DURABLE_EVENT_STORAGE_LIMITS: Readonly<DurableEventStorageLimits> =
  Object.freeze({
    maxEventRows: 10_000,
    maxRevisionSeals: 10_000,
    maxStreams: 2_000,
    maxPayloadBytes: 64 * 1024 * 1024,
  });

/** Published payload retention recommended for version 1. Compaction remains host-authorized. */
export const DEFAULT_DURABLE_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** A health warning threshold; this does not change the hard storage limit. */
export const DEFAULT_DURABLE_EVENT_CAPACITY_WARNING_RATIO = 0.8;

/** A health warning threshold for blocked work; blocked rows still use the normal row limit. */
export const DEFAULT_DURABLE_EVENT_BLOCKED_WARNING_ROWS = 100;

export interface DurableEventStorageStats {
  readonly eventRows: number;
  readonly revisionSeals: number;
  readonly streams: number;
  readonly payloadBytes: number;
  readonly limits: DurableEventStorageLimits;
}

export interface OutstandingDurableEventContract extends DurableEventContract {
  readonly status: 'pending' | 'blocked';
  readonly count: number;
  readonly oldestCreatedAt: number;
}

export type DurableEventApplyResult = 'applied' | 'noop';
