import { bytesToHex } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** Returns a stable, non-reversible correlation token without exposing the sensitive value. */
export function sensitiveValueFingerprint(value: string): string {
  const digest = sha256(new TextEncoder().encode(value));
  return bytesToHex(digest).slice(0, 12);
}

/** Suitable for logs and diagnostic errors that must not contain quote/payment secrets. */
export function redactSensitiveValue(value: string): string {
  return `[redacted:${sensitiveValueFingerprint(value)}]`;
}
