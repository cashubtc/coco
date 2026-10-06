/** Encode bytes as unpadded base64url without requiring Node's Buffer. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url. Padded and unpadded encodings are accepted. */
export function decodeBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error('Invalid base64url alphabet');
  const unpadded = text.replace(/=+$/, '');
  if (unpadded.length % 4 === 1 || (text.includes('=') && text.length % 4 !== 0)) {
    throw new Error('Invalid base64url length or padding');
  }
  const binary = atob(unpadded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== unpadded) throw new Error('Invalid base64url pad bits');
  return bytes;
}

import { encode, decode } from 'cborg';

/** Encode a CBOR-compatible value. */
export function encodeCbor(value: unknown): Uint8Array {
  return encode(value);
}

/** Decode exactly one CBOR item; truncated input and trailing bytes are rejected. */
export function decodeCbor(bytes: Uint8Array): unknown {
  return decode(bytes);
}
