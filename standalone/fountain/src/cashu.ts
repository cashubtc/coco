import { getDecodedTokenBinary, getEncodedTokenBinary, type Token } from '@cashu/cashu-ts';
import { decodeBase64Url, encodeBase64Url, decodeCbor, encodeCbor } from './encoding.js';

export type { Token } from '@cashu/cashu-ts';

const binaryPrefix = new TextEncoder().encode('crawB');

type TokenWire = { t: { p: Record<string, unknown>[] }[] };

function withBinaryPrefix(cbor: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(binaryPrefix.length + cbor.length);
  bytes.set(binaryPrefix);
  bytes.set(cbor, binaryPrefix.length);
  return bytes;
}

function encodeTokenObject(token: Token): Uint8Array {
  const bytes = getEncodedTokenBinary(token);
  if (!token.proofs.some((proof) => typeof proof.witness === 'string')) return bytes;

  // cashu-ts 5.0.0-rc.4 stringifies every witness, including already serialized
  // strings. Remove that extra layer while preserving the original witness text.
  // Keep this compatibility fix local to object encoding; scanned CBOR is untouched.
  const wire = decodeCbor(bytes.subarray(binaryPrefix.length)) as TokenWire;
  for (const group of wire.t)
    for (const proof of group.p) {
      if (typeof proof.w !== 'string') continue;
      const witness: unknown = JSON.parse(proof.w);
      if (typeof witness === 'string') proof.w = witness;
    }
  return withBinaryPrefix(encodeCbor(wire));
}

/** Convert Cashu V4 text or a cashu-ts Token into crawB binary. Text CBOR is preserved. */
export function tokenToBytes(token: string | Token): Uint8Array {
  if (typeof token !== 'string') {
    const bytes = encodeTokenObject(token);
    bytesToToken(bytes);
    return bytes;
  }
  if (!token.startsWith('cashuB')) throw new Error('Only Cashu V4 (cashuB) tokens are supported');
  const cbor = decodeBase64Url(token.slice(6));
  const bytes = withBinaryPrefix(cbor);
  bytesToToken(bytes);
  return bytes;
}

function normalizeTokenBytes(bytes: Uint8Array): Uint8Array {
  if (new TextDecoder().decode(bytes.subarray(0, 6)) === 'cashuB') {
    return tokenToBytes(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  return bytes;
}

/**
 * Decode crawB binary or recovered UTF-8 cashuB bytes into a cashu-ts Token.
 * Keyset IDs retain the encoded length; no mint lookup expands short IDs.
 * cashu-ts normalizes Amount values, defaults missing unit to sat, and returns
 * witness metadata as its serialized JSON string.
 */
export function bytesToToken(bytes: Uint8Array): Token {
  bytes = normalizeTokenBytes(bytes);
  const token = getDecodedTokenBinary(bytes);
  // cashu-ts validates the token/group structure but drops falsy witnesses.
  // Inspect the wire field too, so values such as 0, false and null cannot hide.
  const wire = decodeCbor(bytes.subarray(binaryPrefix.length)) as TokenWire;
  for (const group of wire.t)
    for (const proof of group.p) {
      if (Object.hasOwn(proof, 'w') && typeof proof.w !== 'string') {
        throw new Error('Invalid Cashu V4 witness: expected serialized text');
      }
    }
  if (
    typeof token.mint !== 'string' ||
    token.mint.length === 0 ||
    typeof token.unit !== 'string' ||
    token.unit.length === 0 ||
    token.proofs.length === 0 ||
    (token.memo !== undefined && typeof token.memo !== 'string') ||
    token.proofs.some((proof) => typeof proof.secret !== 'string')
  ) {
    throw new Error('Invalid Cashu V4 token contents');
  }
  return token;
}

/** Convert crawB or UTF-8 cashuB bytes to unpadded cashuB text without reserializing CBOR. */
export function bytesToTokenString(bytes: Uint8Array): string {
  bytes = normalizeTokenBytes(bytes);
  bytesToToken(bytes);
  return 'cashuB' + encodeBase64Url(bytes.subarray(5));
}
