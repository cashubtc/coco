import { Amount, type AmountLike } from '@cashu/cashu-ts';

import { UnitMismatchError, UnitValidationError } from './models/Error.ts';

export const DEFAULT_UNIT = 'sat';

export interface UnitAmount {
  amount: Amount;
  unit: string;
}

export type UnitAmountLike =
  | AmountLike
  | {
      amount: AmountLike;
      unit: string;
    };

export function isUnitAmountLikeObject(
  input: UnitAmountLike,
): input is { amount: AmountLike; unit: string } {
  return typeof input === 'object' && input !== null && 'amount' in input && 'unit' in input;
}

export function normalizeUnit(unit?: string, options?: { defaultUnit?: string }): string {
  const rawUnit = unit === undefined ? options?.defaultUnit : unit;
  if (typeof rawUnit !== 'string') {
    throw new UnitValidationError('Unit is required');
  }

  const normalized = rawUnit.trim().toLowerCase();
  if (!normalized) {
    throw new UnitValidationError('Unit cannot be empty');
  }

  return normalized;
}

export function normalizeUnitList(units?: readonly string[]): string[] | undefined {
  if (units === undefined) return undefined;
  return Array.from(new Set(units.map((unit) => normalizeUnit(unit))));
}

export function assertSameUnit(actual: string, expected: string, context?: string): void {
  const normalizedActual = normalizeUnit(actual);
  const normalizedExpected = normalizeUnit(expected);
  if (normalizedActual !== normalizedExpected) {
    const prefix = context ? `${context}: ` : '';
    throw new UnitMismatchError(
      `${prefix}Unit mismatch: expected ${normalizedExpected}, received ${normalizedActual}`,
    );
  }
}

/**
 * Parse ergonomic public-boundary amount input into canonical `UnitAmount`.
 *
 * Use this at API and hook boundaries only. Internal services, operations, and
 * handlers should accept `UnitAmount` directly so amount+unit cannot be split or
 * accidentally defaulted.
 */
export function parseUnitAmount(
  input: UnitAmountLike,
  options?: {
    defaultUnit?: string;
    explicitUnit?: string;
  },
): UnitAmount {
  const isObjectInput = isUnitAmountLikeObject(input);
  const amountInput = isObjectInput ? input.amount : input;
  const unitInput = isObjectInput
    ? input.unit
    : (options?.explicitUnit ?? options?.defaultUnit ?? DEFAULT_UNIT);
  const unit = normalizeUnit(unitInput);

  if (options?.explicitUnit !== undefined) {
    assertSameUnit(unit, options.explicitUnit, 'Amount input');
  }

  return {
    amount: Amount.from(amountInput),
    unit,
  };
}

/**
 * Normalize an already-coupled amount/unit value for internal service use.
 *
 * `parseUnitAmount()` is the public-boundary parser for ergonomic inputs. Internal
 * service and operation layers should accept `UnitAmount` and use this helper only
 * to canonicalize the `Amount` instance and lower-case the unit.
 */
export function normalizeUnitAmount(value: UnitAmount): UnitAmount {
  return {
    amount: Amount.from(value.amount),
    unit: normalizeUnit(value.unit),
  };
}

export function assertUnitAmount(value: UnitAmount, context = 'Unit amount'): UnitAmount {
  if (!value || typeof value !== 'object') {
    throw new UnitValidationError(`${context} is required`);
  }
  if (!('amount' in value)) {
    throw new UnitValidationError(`${context} amount is required`);
  }
  if (!('unit' in value)) {
    throw new UnitValidationError(`${context} unit is required`);
  }
  return normalizeUnitAmount(value);
}

export function sameUnitAmount(
  amount: UnitAmount,
  expectedUnit: string,
  context?: string,
): UnitAmount {
  const normalized = assertUnitAmount(amount, context ?? 'Unit amount');
  assertSameUnit(normalized.unit, expectedUnit, context);
  return normalized;
}
