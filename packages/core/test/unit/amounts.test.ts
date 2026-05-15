import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';

import {
  assertSameUnit,
  assertUnitAmount,
  DEFAULT_UNIT,
  normalizeUnit,
  normalizeUnitAmount,
  parseUnitAmount,
  sameUnitAmount,
} from '../../amounts.ts';
import { UnitMismatchError, UnitValidationError } from '../../models/Error.ts';

describe('unit amount primitives', () => {
  it('normalizes unit strings by trimming and lowercasing', () => {
    expect(normalizeUnit(' SAT ')).toBe(DEFAULT_UNIT);
    expect(normalizeUnit('USD')).toBe('usd');
  });

  it('requires a unit unless a default is provided', () => {
    expect(() => normalizeUnit()).toThrow(UnitValidationError);
    expect(normalizeUnit(undefined, { defaultUnit: DEFAULT_UNIT })).toBe(DEFAULT_UNIT);
  });

  it('rejects empty units', () => {
    expect(() => normalizeUnit('  ')).toThrow(UnitValidationError);
  });

  it('parses a bare amount as sat', () => {
    const parsed = parseUnitAmount(100);
    expect(parsed.amount.equals(Amount.from(100))).toBe(true);
    expect(parsed.unit).toBe(DEFAULT_UNIT);
  });

  it('parses object-form amounts with normalized units', () => {
    const parsed = parseUnitAmount({ amount: 100, unit: ' USD ' });
    expect(parsed.amount.equals(Amount.from(100))).toBe(true);
    expect(parsed.unit).toBe('usd');
  });

  it('throws when object and explicit units conflict', () => {
    expect(() => parseUnitAmount({ amount: 100, unit: 'usd' }, { explicitUnit: 'sat' })).toThrow(
      UnitMismatchError,
    );
  });

  it('compares units after normalization', () => {
    expect(() => assertSameUnit(' SAT ', 'sat')).not.toThrow();
    expect(() => assertSameUnit('usd', 'sat')).toThrow(UnitMismatchError);
  });

  it('normalizes internal unit amounts without defaulting units', () => {
    const parsed = normalizeUnitAmount({ amount: Amount.from(100), unit: ' USD ' });

    expect(parsed.amount.equals(Amount.from(100))).toBe(true);
    expect(parsed.unit).toBe('usd');
  });

  it('rejects malformed internal unit amounts', () => {
    expect(() => assertUnitAmount({ amount: Amount.from(1), unit: '' })).toThrow(
      UnitValidationError,
    );
    expect(() => assertUnitAmount({ amount: Amount.from(1) } as any)).toThrow(UnitValidationError);
  });

  it('asserts internal unit amounts against expected units', () => {
    const parsed = sameUnitAmount({ amount: Amount.from(100), unit: ' USD ' }, 'usd');

    expect(parsed.unit).toBe('usd');
    expect(() => sameUnitAmount({ amount: Amount.from(100), unit: 'usd' }, 'sat')).toThrow(
      UnitMismatchError,
    );
  });
});
