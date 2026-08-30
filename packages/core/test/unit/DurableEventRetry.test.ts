import { describe, expect, it } from 'bun:test';
import {
  DurableEventValidationError,
  addDurableEventDelay,
  durableEventRetryDelay,
} from '../../outbox/index.ts';

const policy = {
  maxFailures: 5,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  jitterRatio: 0.2,
};

describe('durable event retry policy', () => {
  it('uses capped exponential backoff', () => {
    expect(durableEventRetryDelay(1, policy, 0.5)).toBe(100);
    expect(durableEventRetryDelay(2, policy, 0.5)).toBe(200);
    expect(durableEventRetryDelay(8, policy, 0.5)).toBe(1_000);
  });

  it('applies bounded deterministic jitter', () => {
    expect(durableEventRetryDelay(2, policy, 0)).toBe(160);
    expect(durableEventRetryDelay(2, policy, 1)).toBe(240);
  });

  it('saturates the next attempt time', () => {
    expect(addDurableEventDelay(Number.MAX_SAFE_INTEGER - 5, 10)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects invalid retry inputs', () => {
    expect(() => durableEventRetryDelay(0, policy, 0.5)).toThrow(DurableEventValidationError);
    expect(() => durableEventRetryDelay(1, { ...policy, maxFailures: 0 }, 0.5)).toThrow(
      DurableEventValidationError,
    );
    expect(() => durableEventRetryDelay(1, policy, 2)).toThrow(DurableEventValidationError);
  });
});
