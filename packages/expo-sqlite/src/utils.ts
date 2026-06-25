/**
 * Safely converts a hex string to Uint8Array with validation
 * @throws Error if the hex string is invalid or malformed
 */
export function hexToBytes(hexString: string): Uint8Array {
  // Validate hex string format
  if (!/^[0-9a-fA-F]+$/.test(hexString)) {
    throw new Error(`Invalid hex string: contains non-hex characters`);
  }

  if (hexString.length % 2 !== 0) {
    throw new Error(`Invalid hex string: odd length (${hexString.length})`);
  }

  // Safe conversion with validation
  const matches = hexString.match(/.{2}/g);
  if (!matches) {
    throw new Error(`Failed to parse hex string`);
  }

  return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
}

/**
 * Converts a Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
