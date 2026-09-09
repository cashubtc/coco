import { Amount, type AmountLike } from '@cashu/cashu-ts';
import { DEFAULT_UNIT, normalizeUnit, normalizeUnitAmount, type UnitAmount } from '../amounts.ts';
import { ProofValidationError } from '../models/Error.ts';
import type { MintInfo } from '../types.ts';

export interface MethodUnitCapability {
  supported: boolean;
  disabled: boolean;
  nut: 4 | 5;
  method: string;
  unit: string;
  minAmount?: Amount | null;
  maxAmount?: Amount | null;
  options?: unknown;
  legacySatAllowed?: boolean;
  reason?: string;
}

type NutMethodSetting = {
  method: string;
  unit: string;
  min_amount?: AmountLike | null;
  max_amount?: AmountLike | null;
  options?: unknown;
};

type NutMethodSettings = {
  methods?: NutMethodSetting[];
  disabled?: boolean;
};

/** Evaluate method support from a supplied snapshot without fetching or persisting metadata. */
export function getMethodUnitCapability(
  mintInfo: MintInfo,
  nut: 4 | 5,
  method: string,
  unit: string,
): MethodUnitCapability {
  const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
  const settings = (mintInfo.nuts as Record<string, unknown> | undefined)?.[String(nut)] as
    | NutMethodSettings
    | undefined;
  const nutName = `NUT-${String(nut).padStart(2, '0')}`;

  if (settings?.disabled === true) {
    return {
      supported: false,
      disabled: true,
      nut,
      method,
      unit: normalizedUnit,
      reason: `${nutName} is disabled`,
    };
  }

  if (!settings || !Array.isArray(settings.methods)) {
    return {
      supported: false,
      disabled: false,
      nut,
      method,
      unit: normalizedUnit,
      reason: `${nutName} method metadata is missing`,
    };
  }

  const matchingMethod = settings.methods.find((entry) => {
    try {
      return entry.method === method && normalizeUnit(entry.unit) === normalizedUnit;
    } catch {
      return false;
    }
  });

  if (!matchingMethod) {
    return {
      supported: false,
      disabled: false,
      nut,
      method,
      unit: normalizedUnit,
      reason: `${nutName} method ${method} does not support unit ${normalizedUnit}`,
    };
  }

  return {
    supported: true,
    disabled: false,
    nut,
    method,
    unit: normalizedUnit,
    minAmount: parseOptionalAmount(matchingMethod.min_amount),
    maxAmount: parseOptionalAmount(matchingMethod.max_amount),
    options: matchingMethod.options,
  };
}

/** Validate a method and amount against an already loaded metadata snapshot. */
export function assertMethodUnitCapability(
  mintInfo: MintInfo,
  nut: 4 | 5,
  method: string,
  scope: string | UnitAmount,
): void {
  let unit: string;
  let requestedAmount: Amount | undefined;
  if (typeof scope === 'string') {
    unit = scope;
  } else {
    const intent = normalizeUnitAmount(scope);
    unit = intent.unit;
    requestedAmount = intent.amount;
  }
  const capability = getMethodUnitCapability(mintInfo, nut, method, unit);
  if (!capability.supported) {
    throw new ProofValidationError(
      capability.reason ??
        `NUT-${String(nut).padStart(2, '0')} method ${method} does not support unit ${capability.unit}`,
    );
  }

  if (requestedAmount === undefined) return;

  const amountRequirement = `NUT-${String(nut).padStart(2, '0')} method ${method} unit ${capability.unit}`;
  if (capability.minAmount && requestedAmount.lessThan(capability.minAmount)) {
    throw new ProofValidationError(
      `${amountRequirement} requires amount >= ${capability.minAmount}`,
    );
  }
  if (capability.maxAmount && requestedAmount.greaterThan(capability.maxAmount)) {
    throw new ProofValidationError(
      `${amountRequirement} requires amount <= ${capability.maxAmount}`,
    );
  }
}

function parseOptionalAmount(amount: AmountLike | null | undefined): Amount | null {
  return amount === undefined || amount === null ? null : Amount.from(amount);
}
