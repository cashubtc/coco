import { KeyChain, type KeyChainCache } from '@cashu/cashu-ts';
import type { Keyset } from '@core/models/Keyset.ts';

/** The same fee and selection model is used during preflight and authoritative reservation. */
export function createKeyChain(
  mintUrl: string,
  unit: string,
  keysets: readonly Keyset[],
): KeyChain {
  return KeyChain.fromCache(mintUrl, unit, {
    mintUrl,
    keysets: keysets.map((keyset) => ({
      id: keyset.id,
      unit: keyset.unit,
      active: keyset.active,
      input_fee_ppk: keyset.feePpk,
      keys: keyset.keypairs,
    })),
  } satisfies KeyChainCache);
}
