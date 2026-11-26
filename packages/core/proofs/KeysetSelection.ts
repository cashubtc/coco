import { KeyChain, type KeyChainCache } from '@cashu/cashu-ts';
import { DEFAULT_UNIT, normalizeUnit } from '@core/amounts.ts';
import type { Keyset } from '@core/models/Keyset.ts';

/**
 * The unit a stored keyset is read in: trimmed, lower case, and a blank unit read as the default
 * unit. Storage adapters return an empty unit for a keyset row without one. cashu-ts selects,
 * spends and receives only on keysets whose unit is exactly the wallet unit, so every snapshot
 * Coco hands it uses this reading.
 */
export function normalizeKeysetUnit(unit?: string | null): string {
  return normalizeUnit(unit || DEFAULT_UNIT, { defaultUnit: DEFAULT_UNIT });
}

/**
 * The cashu-ts cache entry for a stored keyset. cashu-ts re-derives every cached id and discards
 * the keys of one that does not match; a v2 id commits to `final_expiry`, so omitting it here makes
 * a valid expiring keyset unusable. A v2 id commits to the lower-case unit, so normalizing the unit
 * keeps the id derivable.
 */
export function toCachedKeyset(keyset: Keyset): KeyChainCache['keysets'][number] {
  return {
    id: keyset.id,
    unit: normalizeKeysetUnit(keyset.unit),
    active: keyset.active,
    input_fee_ppk: keyset.feePpk,
    final_expiry: keyset.finalExpiry,
    keys: keyset.keypairs,
  };
}

/** The same fee and selection model is used during preflight and authoritative reservation. */
export function createKeyChain(
  mintUrl: string,
  unit: string,
  keysets: readonly Keyset[],
): KeyChain {
  return KeyChain.fromCache(mintUrl, unit, {
    mintUrl,
    keysets: keysets.map(toCachedKeyset),
  } satisfies KeyChainCache);
}
