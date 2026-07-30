import { Amount } from '@cashu/cashu-ts';

import {
  type MintSwapEventType,
  type MintSwapOperationState,
} from '../operations/mintSwap/MintSwapOperation';
import { normalizeMintUrl } from '../utils';

export interface MintSwapEventPayload {
  operationId: string;
  revision: number;
  state: MintSwapOperationState;
  sourceMintUrl: string;
  destinationMintUrl: string;
  unit: 'sat';
  destinationAmount: string;
  reasonCode?: string;
}

export interface OperationEventOutboxRecord {
  id: string;
  operationId: string;
  revision: number;
  eventType: MintSwapEventType;
  payload: MintSwapEventPayload;
  createdAt: number;
  publishedAt?: number;
  publishAttempts: number;
  nextAttemptAt?: number;
  lastError?: string;
}

const EVENT_STATE: Partial<Record<MintSwapEventType, MintSwapOperationState>> = {
  'mint-swap-op:prepared': 'prepared',
  'mint-swap-op:source-inflight': 'source_inflight',
  'mint-swap-op:destination-funded': 'destination_funded',
  'mint-swap-op:issuing': 'issuing',
  'mint-swap-op:completed': 'completed',
  'mint-swap-op:cancelled': 'cancelled',
  'mint-swap-op:failed': 'failed',
  'mint-swap-op:needs-attention': 'needs_attention',
};
const EVENT_TYPES = new Set<MintSwapEventType>([
  ...(Object.keys(EVENT_STATE) as MintSwapEventType[]),
  'mint-swap-op:delayed',
]);
const OPERATION_STATES = new Set<MintSwapOperationState>([
  'preparing',
  'prepared',
  'source_inflight',
  'destination_funded',
  'issuing',
  'completed',
  'cancelled',
  'failed',
  'needs_attention',
]);

export function operationEventLogicalKey(
  record: Pick<OperationEventOutboxRecord, 'operationId' | 'revision' | 'eventType'>,
): string {
  return `${record.operationId}\u0000${record.revision}\u0000${record.eventType}`;
}

export function isOperationEventPublished(
  record: Pick<OperationEventOutboxRecord, 'publishedAt'>,
): boolean {
  return record.publishedAt !== undefined;
}

export function isOperationEventDue(
  record: Pick<OperationEventOutboxRecord, 'publishedAt' | 'nextAttemptAt'>,
  now: number,
): boolean {
  assertTimestamp(now, 'Outbox due check time');
  return !isOperationEventPublished(record) && (record.nextAttemptAt ?? 0) <= now;
}

export function validateOperationEventOutboxRecord(
  record: OperationEventOutboxRecord,
): OperationEventOutboxRecord {
  assertNonEmpty(record.id, 'Outbox id');
  assertNonEmpty(record.operationId, 'Outbox operation id');
  assertSafeInteger(record.revision, 'Outbox revision');
  assertTimestamp(record.createdAt, 'Outbox createdAt');
  assertSafeInteger(record.publishAttempts, 'Outbox publish attempts');
  if (!EVENT_TYPES.has(record.eventType)) {
    throw new Error(`Unknown operation outbox event type: ${String(record.eventType)}`);
  }
  if (!OPERATION_STATES.has(record.payload.state)) {
    throw new Error(`Unknown mint swap event state: ${String(record.payload.state)}`);
  }

  if (
    record.payload.operationId !== record.operationId ||
    record.payload.revision !== record.revision
  ) {
    throw new Error('Outbox payload identity must match its logical event key');
  }

  const expectedState = EVENT_STATE[record.eventType];
  if (expectedState !== undefined && record.payload.state !== expectedState) {
    throw new Error(`Outbox ${record.eventType} payload must contain state ${expectedState}`);
  }

  if (record.payload.unit !== 'sat') throw new Error('Outbox mint swap unit must be sat');
  const destinationAmount = Amount.from(record.payload.destinationAmount);
  if (
    destinationAmount.isZero() ||
    destinationAmount.toString().startsWith('-') ||
    destinationAmount.toString() !== record.payload.destinationAmount
  ) {
    throw new Error('Outbox destination amount must be a positive canonical decimal string');
  }

  const sourceMintUrl = normalizeMintUrl(record.payload.sourceMintUrl);
  const destinationMintUrl = normalizeMintUrl(record.payload.destinationMintUrl);
  if (
    record.payload.sourceMintUrl !== sourceMintUrl ||
    record.payload.destinationMintUrl !== destinationMintUrl
  ) {
    throw new Error('Outbox mint URLs must be normalized');
  }
  if (sourceMintUrl === destinationMintUrl) {
    throw new Error('Outbox source and destination mints must be distinct');
  }

  if (record.payload.reasonCode !== undefined) {
    assertNonEmpty(record.payload.reasonCode, 'Outbox reason code');
  }
  if (record.lastError !== undefined) assertNonEmpty(record.lastError, 'Outbox last error');

  if (record.nextAttemptAt !== undefined) {
    assertTimestamp(record.nextAttemptAt, 'Outbox nextAttemptAt');
    if (record.nextAttemptAt < record.createdAt) {
      throw new Error('Outbox nextAttemptAt cannot precede createdAt');
    }
  }
  if (record.publishedAt !== undefined) {
    assertTimestamp(record.publishedAt, 'Outbox publishedAt');
    if (record.publishedAt < record.createdAt) {
      throw new Error('Outbox publishedAt cannot precede createdAt');
    }
    if (record.nextAttemptAt !== undefined || record.lastError !== undefined) {
      throw new Error('Published outbox records cannot retain retry scheduling');
    }
  } else if (record.publishAttempts === 0) {
    if (record.nextAttemptAt !== undefined || record.lastError !== undefined) {
      throw new Error('An unattempted outbox record cannot contain retry scheduling');
    }
  } else if (record.nextAttemptAt === undefined || record.lastError === undefined) {
    throw new Error('A failed outbox publication requires retry time and error evidence');
  }

  return record;
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative Unix-millisecond timestamp`);
  }
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} cannot be empty`);
}
