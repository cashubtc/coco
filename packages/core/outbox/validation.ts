import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DurableEventCorruptRecordError, DurableEventValidationError } from './errors.ts';
import type {
  ClaimedDurableEvent,
  DurableEventContract,
  DurableEventIntent,
  DurableEventRevisionBatch,
  JsonObject,
  JsonValue,
  PreparedDurableEventIntent,
  PreparedDurableEventRevisionBatch,
} from './types.ts';

export const DURABLE_EVENT_ENVELOPE_VERSION = 1;
export const MAX_DURABLE_EVENT_PAYLOAD_BYTES = 64 * 1024;
export const MAX_DURABLE_EVENT_BATCH_BYTES = 512 * 1024;
export const MAX_DURABLE_EVENTS_PER_BATCH = 32;

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_OPAQUE_ID_LENGTH = 256;
const MAX_JSON_DEPTH = 32;
const DOTTED_IDENTIFIER = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const OPAQUE_ASCII = /^[\x21-\x7e]+$/;
const textEncoder = new TextEncoder();

function fail(message: string): never {
  throw new DurableEventValidationError(message);
}

function assertSafeInteger(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
}

export function assertDurableEventTimestamp(value: number, name: string): void {
  assertSafeInteger(value, name);
}

function assertDottedIdentifier(value: string, name: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !DOTTED_IDENTIFIER.test(value)
  ) {
    fail(`${name} must be a lowercase dotted identifier`);
  }
}

function assertOpaqueIdentifier(value: string, name: string): void {
  if (value.length === 0 || value.length > MAX_OPAQUE_ID_LENGTH || !OPAQUE_ASCII.test(value)) {
    fail(`${name} must be a bounded printable ASCII identifier`);
  }
}

export function assertDurableEventOpaqueIdentifier(value: string, name: string): void {
  assertOpaqueIdentifier(value, name);
}

export function assertSafeDurableEventFailure(failure: {
  readonly code: string;
  readonly message?: string;
}): void {
  assertDottedIdentifier(failure.code, 'failure code');
  if (failure.message !== undefined) {
    if (failure.message.length === 0 || failure.message.length > 256) {
      fail('safe failure message must contain between 1 and 256 characters');
    }
    assertValidString(failure.message, 'safe failure message');
    if (/\p{Cc}/u.test(failure.message))
      fail('safe failure message must not contain control characters');
  }
}

function assertValidString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail(`${path} contains an unpaired surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${path} contains an unpaired surrogate`);
    }
  }
}

function normalizeJson(value: unknown, path: string, depth: number): JsonValue {
  if (depth > MAX_JSON_DEPTH) fail(`${path} exceeds the maximum JSON depth`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    assertValidString(value, path);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} must contain a finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) fail(`${path} must not contain symbol keys`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key !== 'length' && !('value' in descriptor)) {
        fail(`${path}[${key}] must not use an accessor`);
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) fail(`${path} must not be sparse`);
    }
    const allowedKeys = new Set([...value.keys()].map(String).concat('length'));
    if (keys.some((key) => typeof key === 'string' && !allowedKeys.has(key))) {
      fail(`${path} must not contain extra array properties`);
    }
    return value.map((entry, index) => normalizeJson(entry, `${path}[${index}]`, depth + 1));
  }
  if (typeof value !== 'object') fail(`${path} contains a value that JSON cannot store`);

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${path} must contain only plain objects`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) fail(`${path} must not contain symbol keys`);

  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key]!;
    if (!('value' in descriptor)) fail(`${path}.${key} must not use an accessor`);
    if (!descriptor.enumerable) continue;
    assertValidString(key, `${path} key`);
    result[key] = normalizeJson(descriptor.value, `${path}.${key}`, depth + 1);
  }
  return result;
}

export function canonicalizeJsonObject(value: unknown): {
  value: JsonObject;
  json: string;
  bytes: number;
} {
  const normalized = normalizeJson(value, 'payload', 0);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== 'object') {
    fail('payload must be a plain JSON object');
  }
  const json = JSON.stringify(normalized);
  const bytes = textEncoder.encode(json).byteLength;
  if (bytes > MAX_DURABLE_EVENT_PAYLOAD_BYTES) {
    fail(`payload must not exceed ${MAX_DURABLE_EVENT_PAYLOAD_BYTES} bytes`);
  }
  return { value: normalized, json, bytes };
}

export function canonicalizeJson(value: JsonValue): string {
  return JSON.stringify(normalizeJson(value, 'value', 0));
}

function hashCanonicalJson(value: JsonValue): string {
  return bytesToHex(sha256(textEncoder.encode(canonicalizeJson(value))));
}

export function durableEventContractKey(contract: DurableEventContract): string {
  return [
    contract.consumerId,
    contract.eventType,
    contract.envelopeVersion,
    contract.payloadVersion,
  ].join('\u0000');
}

export function assertDurableEventContract(contract: DurableEventContract): void {
  assertDottedIdentifier(contract.consumerId, 'consumer id');
  assertDottedIdentifier(contract.eventType, 'event type');
  assertSafeInteger(contract.envelopeVersion, 'envelope version', 1);
  assertSafeInteger(contract.payloadVersion, 'payload version', 1);
  if (contract.envelopeVersion !== DURABLE_EVENT_ENVELOPE_VERSION) {
    fail(`envelope version must be ${DURABLE_EVENT_ENVELOPE_VERSION}`);
  }
}

export function durableEventLogicalKey(intent: DurableEventIntent): string {
  return [intent.streamId, intent.streamRevision, intent.consumerId, intent.eventKey].join(
    '\u0000',
  );
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateIntentIdentity(
  intent: DurableEventIntent,
  batch: DurableEventRevisionBatch,
): void {
  assertOpaqueIdentifier(intent.id, 'event id');
  assertOpaqueIdentifier(intent.eventKey, 'event key');
  assertOpaqueIdentifier(intent.streamId, 'stream id');
  assertDurableEventContract(intent);
  assertSafeInteger(intent.streamRevision, 'stream revision');
  assertSafeInteger(intent.occurredAt, 'occurredAt');
  if (intent.streamId !== batch.streamId || intent.streamRevision !== batch.streamRevision) {
    fail('each event must use the batch stream and revision');
  }
}

export function prepareDurableEventRevisionBatch(
  batch: DurableEventRevisionBatch,
  sealedAt: number,
): PreparedDurableEventRevisionBatch {
  assertOpaqueIdentifier(batch.streamId, 'stream id');
  assertSafeInteger(batch.streamRevision, 'stream revision');
  assertSafeInteger(sealedAt, 'sealedAt');
  if (batch.expectedPreviousRevision !== null) {
    assertSafeInteger(batch.expectedPreviousRevision, 'expected previous revision');
    if (batch.expectedPreviousRevision >= batch.streamRevision) {
      fail('expected previous revision must be less than the stream revision');
    }
  }
  if (batch.events.length === 0) fail('an event revision batch must not be empty');
  if (batch.events.length > MAX_DURABLE_EVENTS_PER_BATCH) {
    fail(
      `an event revision batch must not contain more than ${MAX_DURABLE_EVENTS_PER_BATCH} events`,
    );
  }

  const ids = new Set<string>();
  const logicalKeys = new Set<string>();
  const events: PreparedDurableEventIntent[] = batch.events.map((intent) => {
    validateIntentIdentity(intent, batch);
    if (ids.has(intent.id)) fail(`event id ${intent.id} is duplicated`);
    ids.add(intent.id);
    const logicalKey = durableEventLogicalKey(intent);
    if (logicalKeys.has(logicalKey)) fail(`event key ${intent.eventKey} is duplicated`);
    logicalKeys.add(logicalKey);

    const payload = canonicalizeJsonObject(intent.payload);
    const semanticIntent: JsonObject = {
      consumerId: intent.consumerId,
      envelopeVersion: intent.envelopeVersion,
      eventKey: intent.eventKey,
      eventType: intent.eventType,
      occurredAt: intent.occurredAt,
      payload: payload.value,
      payloadVersion: intent.payloadVersion,
      streamId: intent.streamId,
      streamRevision: intent.streamRevision,
    };
    return {
      ...intent,
      payload: payload.value,
      payloadJson: payload.json,
      payloadBytes: payload.bytes,
      contentHash: hashCanonicalJson(semanticIntent),
    };
  });

  const sealedEvents = events
    .map((event) => ({
      consumerId: event.consumerId,
      contentHash: event.contentHash,
      eventKey: event.eventKey,
      eventType: event.eventType,
      envelopeVersion: event.envelopeVersion,
      payloadVersion: event.payloadVersion,
    }))
    .sort((left, right) =>
      compareCanonicalText(
        `${left.consumerId}\u0000${left.eventKey}`,
        `${right.consumerId}\u0000${right.eventKey}`,
      ),
    );
  const batchEnvelope: JsonObject = {
    expectedPreviousRevision: batch.expectedPreviousRevision,
    streamId: batch.streamId,
    streamRevision: batch.streamRevision,
    events: sealedEvents,
  };
  const canonicalBatch = canonicalizeJson(batchEnvelope);
  const canonicalSizeEnvelope: JsonObject = {
    expectedPreviousRevision: batch.expectedPreviousRevision,
    streamId: batch.streamId,
    streamRevision: batch.streamRevision,
    events: events
      .map((event) => ({
        consumerId: event.consumerId,
        envelopeVersion: event.envelopeVersion,
        eventKey: event.eventKey,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        payload: event.payload,
        payloadVersion: event.payloadVersion,
      }))
      .sort((left, right) =>
        compareCanonicalText(
          `${left.consumerId}\u0000${left.eventKey}`,
          `${right.consumerId}\u0000${right.eventKey}`,
        ),
      ),
  };
  const canonicalBytes = textEncoder.encode(canonicalizeJson(canonicalSizeEnvelope)).byteLength;
  if (canonicalBytes > MAX_DURABLE_EVENT_BATCH_BYTES) {
    fail(`event revision batch must not exceed ${MAX_DURABLE_EVENT_BATCH_BYTES} bytes`);
  }

  return {
    events,
    canonicalBytes,
    seal: {
      streamId: batch.streamId,
      expectedPreviousRevision: batch.expectedPreviousRevision,
      streamRevision: batch.streamRevision,
      eventCount: events.length,
      eventSetHash: bytesToHex(sha256(textEncoder.encode(canonicalBatch))),
      sealedAt,
    },
  };
}

export function assertClaimedDurableEventIntegrity(event: ClaimedDurableEvent): void {
  let prepared: PreparedDurableEventRevisionBatch;
  try {
    prepared = prepareDurableEventRevisionBatch(
      {
        streamId: event.streamId,
        expectedPreviousRevision: event.streamRevision === 0 ? null : event.streamRevision - 1,
        streamRevision: event.streamRevision,
        events: [event],
      },
      event.createdAt,
    );
  } catch (error) {
    throw new DurableEventCorruptRecordError(event.id, 'Durable event record is invalid');
  }
  const current = prepared.events[0]!;
  if (
    current.payloadJson !== event.payloadJson ||
    current.payloadBytes !== event.payloadBytes ||
    current.contentHash !== event.contentHash
  ) {
    throw new DurableEventCorruptRecordError(event.id, 'Durable event content hash does not match');
  }
}
