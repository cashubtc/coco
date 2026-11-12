import { KeyChain, type KeyChainCache } from '@cashu/cashu-ts';
import type { Keyset } from '@core/models/Keyset.ts';

/**
 * The cashu-ts cache entry for a stored keyset. cashu-ts re-derives every cached id and discards
 * the keys of one that does not match; a v2 id commits to `final_expiry`, so omitting it here makes
 * a valid expiring keyset unusable.
 */
export function toCachedKeyset(keyset: Keyset): KeyChainCache['keysets'][number] {
  return {
    id: keyset.id,
    unit: keyset.unit,
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
