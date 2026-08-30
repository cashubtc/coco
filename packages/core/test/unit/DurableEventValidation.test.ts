import { describe, expect, it } from 'bun:test';
import {
  DurableEventValidationError,
  MAX_DURABLE_EVENT_PAYLOAD_BYTES,
  canonicalizeJsonObject,
  prepareDurableEventRevisionBatch,
} from '../../outbox/index.ts';
import type { DurableEventIntent, DurableEventRevisionBatch } from '../../outbox/types.ts';

function event(overrides: Partial<DurableEventIntent> = {}): DurableEventIntent {
  return {
    id: 'event-1',
    envelopeVersion: 1,
    eventKey: 'project-history',
    eventType: 'wallet.operation.finalized',
    consumerId: 'wallet.history.projector',
    streamId: 'operation-1',
    streamRevision: 7,
    payloadVersion: 1,
    payload: { operationId: 'operation-1', amount: '21' },
    occurredAt: 1_700_000_000_000,
    ...overrides,
  };
}

function batch(events: readonly DurableEventIntent[]): DurableEventRevisionBatch {
  return {
    streamId: 'operation-1',
    expectedPreviousRevision: 6,
    streamRevision: 7,
    events,
  };
}

describe('durable event validation and sealing', () => {
  it('creates the same semantic hashes for different object key order and event IDs', () => {
    const first = prepareDurableEventRevisionBatch(batch([event()]), 1_700_000_000_100);
    const second = prepareDurableEventRevisionBatch(
      batch([
        event({
          id: 'event-retried',
          payload: { amount: '21', operationId: 'operation-1' },
        }),
      ]),
      1_700_000_000_200,
    );

    expect(first.events[0]?.payloadJson).toBe('{"amount":"21","operationId":"operation-1"}');
    expect(first.events[0]?.contentHash).toBe(second.events[0]?.contentHash);
    expect(first.seal.eventSetHash).toBe(second.seal.eventSetHash);
    expect(first.seal.sealedAt).not.toBe(second.seal.sealedAt);
  });

  it('includes contract and occurrence fields in semantic equality', () => {
    const original = prepareDurableEventRevisionBatch(batch([event()]), 1);
    const changedTime = prepareDurableEventRevisionBatch(
      batch([event({ occurredAt: 1_700_000_000_001 })]),
      1,
    );
    const changedConsumer = prepareDurableEventRevisionBatch(
      batch([event({ consumerId: 'wallet.audit.projector' })]),
      1,
    );

    expect(changedTime.seal.eventSetHash).not.toBe(original.seal.eventSetHash);
    expect(changedConsumer.seal.eventSetHash).not.toBe(original.seal.eventSetHash);
  });

  it('seals a semantic event set independent of input and generated ID order', () => {
    const firstEvent = event({ id: 'z-id', eventKey: 'z-event' });
    const secondEvent = event({ id: 'a-id', eventKey: 'a-event' });
    const first = prepareDurableEventRevisionBatch(batch([firstEvent, secondEvent]), 1);
    const retried = prepareDurableEventRevisionBatch(
      batch([
        { ...secondEvent, id: 'new-second-id' },
        { ...firstEvent, id: 'new-first-id' },
      ]),
      2,
    );

    expect(retried.seal.eventSetHash).toBe(first.seal.eventSetHash);
  });

  it('rejects empty batches and duplicate logical event keys', () => {
    expect(() => prepareDurableEventRevisionBatch(batch([]), 1)).toThrow(
      DurableEventValidationError,
    );
    expect(() =>
      prepareDurableEventRevisionBatch(batch([event(), event({ id: 'event-2' })]), 1),
    ).toThrow('event key project-history is duplicated');
  });

  it('rejects mismatched stream data and invalid revision order', () => {
    expect(() =>
      prepareDurableEventRevisionBatch(batch([event({ streamRevision: 8 })]), 1),
    ).toThrow('each event must use the batch stream and revision');
    expect(() =>
      prepareDurableEventRevisionBatch({ ...batch([event()]), expectedPreviousRevision: 7 }, 1),
    ).toThrow('expected previous revision must be less than the stream revision');
  });

  it('rejects values that do not have a stable JSON representation', () => {
    const sparse: unknown[] = [];
    sparse[1] = 'value';
    const withAccessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => 'value',
    });

    for (const payload of [
      { value: undefined },
      { value: Number.NaN },
      { value: 1n },
      { value: new Date() },
      { value: sparse },
      withAccessor,
    ]) {
      expect(() => canonicalizeJsonObject(payload)).toThrow(DurableEventValidationError);
    }
  });

  it('keeps special object keys as data', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}');
    const canonical = canonicalizeJsonObject(payload);

    expect(canonical.json).toBe('{"__proto__":{"polluted":true},"constructor":"value"}');
    expect(Object.getPrototypeOf(canonical.value)).toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects payloads above the byte limit', () => {
    const payload = { value: 'x'.repeat(MAX_DURABLE_EVENT_PAYLOAD_BYTES) };
    expect(() => canonicalizeJsonObject(payload)).toThrow(
      `payload must not exceed ${MAX_DURABLE_EVENT_PAYLOAD_BYTES} bytes`,
    );
  });

  it('applies the batch byte limit to payload data', () => {
    const events = Array.from({ length: 9 }, (_, index) =>
      event({
        id: `event-${index}`,
        eventKey: `event-${index}`,
        payload: { value: 'x'.repeat(60_000) },
      }),
    );

    expect(() => prepareDurableEventRevisionBatch(batch(events), 1)).toThrow(
      'event revision batch must not exceed',
    );
  });
});
