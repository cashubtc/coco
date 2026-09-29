import { KeysetKeysConflictError } from './Error.ts';

export type KeysetKeypairs = Record<string, string>;

export interface Keyset {
  mintUrl: string;
  id: string;
  unit: string;
  keypairs: KeysetKeypairs;
  active: boolean;
  feePpk: number;
  updatedAt: number;
}

/**
 * NUT-02: a keyset id commits to its keys, so the keys behind an id can never legitimately
 * change. Returns the keys a store must persist when a keyset is written again: stored keys win,
 * and incoming keys are adopted only to backfill a keyset whose metadata was recorded without
 * them. Differing keys mean a compromised mint or a corrupted store, so they are rejected.
 */
export function reconcileKeysetKeypairs(
  mintUrl: string,
  keysetId: string,
  stored: KeysetKeypairs | null | undefined,
  incoming: KeysetKeypairs,
): KeysetKeypairs {
  if (!stored || Object.keys(stored).length === 0) return incoming;
  if (Object.keys(incoming).length === 0) return stored;
  const differs =
    JSON.stringify(Object.entries(stored).sort()) !==
    JSON.stringify(Object.entries(incoming).sort());
  if (differs) throw new KeysetKeysConflictError(mintUrl, keysetId);
  return stored;
}
