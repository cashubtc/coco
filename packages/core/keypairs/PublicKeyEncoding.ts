import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';

/** Canonical SEC1 compressed encoding with the key's actual `02` or `03` parity prefix. */
export function canonicalPublicKeyHex(secretKey: Uint8Array): string {
  return bytesToHex(secp256k1.getPublicKey(secretKey, true));
}

/**
 * Legacy coco encoding: always `02` over the x-only coordinate. Older versions persisted P2PK keys
 * this way; it equals the canonical encoding for even-Y keys and differs only for odd-Y keys.
 */
export function legacyPublicKeyHex(canonicalKey: string): string {
  return '02' + canonicalKey.slice(2);
}
