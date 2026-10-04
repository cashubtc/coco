import type { MintMethod } from '../operations/mint/MintMethodHandler';

/** Compares quote ownership without changing the mint's reported public keys. */
export function hasSameMintQuoteOwnership(
  method: MintMethod,
  leftPubkey: string | null | undefined,
  rightPubkey: string | null | undefined,
): boolean {
  // Some mints represent unlocked BOLT11 quotes with an empty public key.
  if (method === 'bolt11') return (leftPubkey || undefined) === (rightPubkey || undefined);
  return (leftPubkey ?? undefined) === (rightPubkey ?? undefined);
}
