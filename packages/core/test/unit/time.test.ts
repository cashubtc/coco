import { describe, expect, it } from 'bun:test';
import { unixMillisecondsToSeconds, unixSecondsToMilliseconds } from '../../time.ts';

describe('time conversions', () => {
  it('rounds Unix milliseconds down to whole seconds', () => {
    expect(unixMillisecondsToSeconds(1_999)).toBe(1);
  });

  it('preserves zero across both conversions', () => {
    expect(unixMillisecondsToSeconds(0)).toBe(0);
    expect(unixSecondsToMilliseconds(0)).toBe(0);
  });

  it('converts seconds to milliseconds without rounding', () => {
    expect(unixSecondsToMilliseconds(1.5)).toBe(1_500);
  });
});
