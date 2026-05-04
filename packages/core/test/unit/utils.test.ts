import { describe, expect, it } from 'bun:test';

import { deserializeAmount, serializeAmount } from '../../utils';

describe('amount serialization utilities', () => {
  it('serializes amounts as canonical integer decimal text', () => {
    expect(serializeAmount(100)).toBe('100');
  });

  it('deserializes canonical integer decimal text', () => {
    expect(deserializeAmount('100').toString()).toBe('100');
  });

  it('rejects decimal amount strings', () => {
    expect(() => deserializeAmount('100.0')).toThrow();
  });
});
