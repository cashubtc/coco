import { DurableEventValidationError } from './errors.ts';

export interface DurableEventRetryPolicy {
  readonly maxFailures: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export const DEFAULT_DURABLE_EVENT_RETRY_POLICY: Readonly<DurableEventRetryPolicy> = Object.freeze({
  maxFailures: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60 * 1_000,
  jitterRatio: 0.2,
});

export const DEFAULT_DURABLE_EVENT_LEASE_DURATION_MS = 30_000;
export const DEFAULT_DURABLE_EVENT_PUBLISH_BATCH_LIMIT = 25;

function assertPolicy(policy: DurableEventRetryPolicy): void {
  if (!Number.isSafeInteger(policy.maxFailures) || policy.maxFailures < 1) {
    throw new DurableEventValidationError('maxFailures must be a positive safe integer');
  }
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw new DurableEventValidationError('baseDelayMs must be a nonnegative safe integer');
  }
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new DurableEventValidationError('maxDelayMs must be a safe integer at least baseDelayMs');
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new DurableEventValidationError('jitterRatio must be between zero and one');
  }
}

export function durableEventRetryDelay(
  failureCount: number,
  policy: DurableEventRetryPolicy,
  jitterUnit: number,
): number {
  assertPolicy(policy);
  if (!Number.isSafeInteger(failureCount) || failureCount < 1) {
    throw new DurableEventValidationError('failureCount must be a positive safe integer');
  }
  if (!Number.isFinite(jitterUnit) || jitterUnit < 0 || jitterUnit > 1) {
    throw new DurableEventValidationError('jitterUnit must be between zero and one');
  }

  const exponent = Math.min(failureCount - 1, 52);
  const uncapped = policy.baseDelayMs * 2 ** exponent;
  const capped = Math.min(
    Number.isSafeInteger(uncapped) ? uncapped : policy.maxDelayMs,
    policy.maxDelayMs,
  );
  const jitterRange = Math.floor(capped * policy.jitterRatio);
  const jitter = Math.floor((jitterUnit * 2 - 1) * jitterRange);
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, capped + jitter));
}

export function addDurableEventDelay(now: number, delay: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(delay) || delay < 0) {
    throw new DurableEventValidationError('retry time values must be nonnegative safe integers');
  }
  return Math.min(Number.MAX_SAFE_INTEGER, now + delay);
}
