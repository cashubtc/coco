import { describe, expect, it } from 'bun:test';
import { Amount, type Token } from '@cashu/cashu-ts';

import { deserializeAmount, isValidToken, serializeAmount } from '../../utils';

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

describe('token validation utilities', () => {
  const makeToken = (amount: unknown): Token =>
    ({
      mint: 'https://mint.example.com',
      proofs: [
        {
          id: 'keyset-id',
          amount,
          secret: 'secret',
          C: 'C',
        },
      ],
    }) as Token;

  it('accepts positive Amount proof amounts', () => {
    expect(() => isValidToken(makeToken(Amount.from(1)))).not.toThrow();
  });

  it('rejects missing proof amounts', () => {
    expect(() => isValidToken(makeToken(undefined))).toThrow(
      'Token proofs must have a positive amount',
    );
  });

  it('rejects zero Amount proof amounts', () => {
    expect(() => isValidToken(makeToken(Amount.zero()))).toThrow(
      'Token proofs must have a positive amount',
    );
  });
});
