import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MINT_SWAP_DISPATCH_WINDOW_SECONDS,
  evaluateMintSwapDispatchWindow,
} from '../../models/MintSwapPolicy';
import { redactSensitiveValue } from '../../logging/redaction';

describe('mint swap protocol policy', () => {
  it('uses the earliest finite expiry and the 120-second default', () => {
    const result = evaluateMintSwapDispatchWindow({
      expiries: [0, null, 1_300, 1_250, 1_400],
      now: 1_100,
    });

    expect(result.dispatchDeadline).toBe(1_250);
    expect(result.remainingSeconds).toBe(150);
    expect(result.requiredWindowSeconds).toBe(DEFAULT_MINT_SWAP_DISPATCH_WINDOW_SECONDS);
    expect(result.canDispatch).toBe(true);
  });

  it('rejects dispatch inside the configured window and windows below 30 seconds', () => {
    expect(evaluateMintSwapDispatchWindow({ expiries: [1_219], now: 1_100 }).canDispatch).toBe(
      false,
    );
    expect(() =>
      evaluateMintSwapDispatchWindow({
        expiries: [1_300],
        now: 1_100,
        requiredWindowSeconds: 29,
      }),
    ).toThrow('at least 30 seconds');
  });

  it('rejects malformed finite expiries instead of silently weakening the deadline', () => {
    expect(() => evaluateMintSwapDispatchWindow({ expiries: [-1, 1_300], now: 1_100 })).toThrow(
      'positive Unix timestamp',
    );
    expect(() =>
      evaluateMintSwapDispatchWindow({ expiries: [Number.MAX_SAFE_INTEGER + 1], now: 1_100 }),
    ).toThrow('positive Unix timestamp');
  });

  it('redacts sensitive identifiers with a stable diagnostic fingerprint', () => {
    const secret = 'quote-id-that-must-not-appear';
    const redacted = redactSensitiveValue(secret);

    expect(redacted).toBe(redactSensitiveValue(secret));
    expect(redacted).not.toContain(secret);
    expect(redacted).toMatch(/^\[redacted:[0-9a-f]{12}\]$/);
  });
});
