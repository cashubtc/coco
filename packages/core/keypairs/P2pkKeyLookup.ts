import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import type { Keypair } from '../models/Keypair.ts';
import type { KeypairQueries } from './KeypairQueries.ts';

/**
 * Resolves canonical SEC1 and legacy always-02 P2PK identities without changing stored rows.
 * Uses at most two reads. Mutation callers must supply their transaction's scoped key access.
 */
export async function findP2pkKeyPair(
  keys: Pick<KeypairQueries, 'getPersistedKeyPair'>,
  publicKey: string,
): Promise<Keypair | null> {
  const directMatch = await keys.getPersistedKeyPair(publicKey, 'p2pk');
  if (directMatch) return directMatch;
  if (!/^0[23][0-9a-f]{64}$/.test(publicKey)) return null;

  const alternateKey = (publicKey.startsWith('02') ? '03' : '02') + publicKey.slice(2);
  const candidate = await keys.getPersistedKeyPair(alternateKey, 'p2pk');
  if (!candidate) return null;

  // Flipping parity alone is insufficient: an even-Y key has no distinct legacy alias.
  const canonicalKey = bytesToHex(secp256k1.getPublicKey(candidate.secretKey, true));
  const legacyKey = '02' + canonicalKey.slice(2);
  return publicKey === canonicalKey || publicKey === legacyKey ? candidate : null;
}
