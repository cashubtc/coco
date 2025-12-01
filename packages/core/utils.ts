import { OutputData, type Proof } from '@cashu/cashu-ts';
import type { CoreProof, ProofState } from './types';
import type { Logger } from './logging/Logger.ts';
import { hashToCurve } from '@cashu/cashu-ts/crypto/common';

// ============================================================================
// OutputData Serialization Types
// ============================================================================

/**
 * Serialized form of a BlindedMessage (JSON-safe)
 */
export interface SerializedBlindedMessage {
  amount: number;
  id: string;
  B_: string;
}

/**
 * Serialized form of a single OutputData entry (JSON-safe)
 */
export interface SerializedOutput {
  blindedMessage: SerializedBlindedMessage;
  blindingFactor: string; // hex-encoded bigint
  secret: string; // hex-encoded Uint8Array
}

/**
 * Serialized form of OutputData for keep and send (JSON-safe)
 */
export interface SerializedOutputData {
  keep: SerializedOutput[];
  send: SerializedOutput[];
}

// ============================================================================
// OutputData Serialization Functions
// ============================================================================

/**
 * Convert a Uint8Array to hex string
 */
function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert a hex string to Uint8Array
 */
function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Serialize a single OutputData to JSON-safe format
 */
export function serializeOutput(output: OutputData): SerializedOutput {
  return {
    blindedMessage: {
      amount: output.blindedMessage.amount,
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: output.blindingFactor.toString(16),
    secret: uint8ArrayToHex(output.secret),
  };
}

/**
 * Deserialize a single SerializedOutput back to OutputData
 */
export function deserializeOutput(serialized: SerializedOutput): OutputData {
  return new OutputData(
    {
      amount: serialized.blindedMessage.amount,
      id: serialized.blindedMessage.id,
      B_: serialized.blindedMessage.B_,
    },
    BigInt('0x' + serialized.blindingFactor),
    hexToUint8Array(serialized.secret),
  );
}

/**
 * Serialize OutputData arrays for keep and send to JSON-safe format
 */
export function serializeOutputData(data: {
  keep: OutputData[];
  send: OutputData[];
}): SerializedOutputData {
  return {
    keep: data.keep.map(serializeOutput),
    send: data.send.map(serializeOutput),
  };
}

/**
 * Deserialize SerializedOutputData back to OutputData arrays
 */
export function deserializeOutputData(serialized: SerializedOutputData): {
  keep: OutputData[];
  send: OutputData[];
} {
  return {
    keep: serialized.keep.map(deserializeOutput),
    send: serialized.send.map(deserializeOutput),
  };
}

/**
 * Decode a hex-encoded secret to its string representation (matching proof.secret)
 */
function decodeSecretHex(hexSecret: string): string {
  const bytes = hexToUint8Array(hexSecret);
  return new TextDecoder().decode(bytes);
}

/**
 * Extract secrets from serialized output data.
 * Returns the string form of secrets (matching proof.secret in Proof objects).
 */
export function getSecretsFromSerializedOutputData(serialized: SerializedOutputData): {
  keepSecrets: string[];
  sendSecrets: string[];
} {
  return {
    keepSecrets: serialized.keep.map((o) => decodeSecretHex(o.secret)),
    sendSecrets: serialized.send.map((o) => decodeSecretHex(o.secret)),
  };
}

export function mapProofToCoreProof(
  mintUrl: string,
  state: ProofState,
  proofs: Proof[],
): CoreProof[] {
  return proofs.map((p) => ({
    ...p,
    mintUrl,
    state,
  }));
}

export function assertNonNegativeInteger(paramName: string, value: number, logger?: Logger): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    logger?.warn('Invalid numeric value', { [paramName]: value });
    throw new Error(`${paramName} must be a non-negative integer`);
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  let base64: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Buf = (globalThis as any).Buffer;
  if (typeof Buf !== 'undefined') {
    base64 = Buf.from(bytes).toString('base64');
  } else if (typeof btoa !== 'undefined') {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    base64 = btoa(bin);
  }
  if (!base64) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateSubId(): string {
  const length = 16;
  const bytes = new Uint8Array(length);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cryptoObj: any = (globalThis as any).crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return toBase64Url(bytes);
}

/**
 * Compute the Y point (hex, compressed) for a single secret using hash-to-curve.
 */
export function computeYHexForSecrets(secrets: string[]): string[] {
  const encoder = new TextEncoder();
  return secrets.map((secret) => hashToCurve(encoder.encode(secret)).toHex(true));
}

/**
 * Build bidirectional maps between secrets and their Y points (hex) using hash-to-curve.
 * - yHexBySecret: secret -> Y hex
 * - secretByYHex: Y hex -> secret
 */
export function buildYHexMapsForSecrets(secrets: string[]): {
  yHexBySecret: Map<string, string>;
  secretByYHex: Map<string, string>;
} {
  const yHexBySecret = new Map<string, string>();
  const secretByYHex = new Map<string, string>();
  const yHexes = computeYHexForSecrets(secrets);
  for (let i = 0; i < secrets.length; i++) {
    const secret = secrets[i];
    const yHex = yHexes[i];
    if (!secret || !yHex) continue;
    yHexBySecret.set(secret, yHex);
    secretByYHex.set(yHex, secret);
  }
  return { yHexBySecret, secretByYHex };
}

/**
 * Normalize a mint URL to prevent duplicates from variations like:
 * - Trailing slashes: https://mint.com/ -> https://mint.com
 * - Case differences in hostname: https://MINT.com -> https://mint.com
 * - Default ports: https://mint.com:443 -> https://mint.com
 * - Redundant path segments: https://mint.com/./path -> https://mint.com/path
 */
export function normalizeMintUrl(mintUrl: string): string {
  const url = new URL(mintUrl);

  // URL constructor already lowercases hostname and normalizes path
  // Remove default ports
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  // Build normalized URL without trailing slash
  let normalized = `${url.protocol}//${url.host}${url.pathname}`;

  // Remove trailing slash (but keep root path as just the origin)
  if (normalized.endsWith('/') && url.pathname !== '/') {
    normalized = normalized.slice(0, -1);
  } else if (url.pathname === '/') {
    // For root path, remove the trailing slash entirely
    normalized = `${url.protocol}//${url.host}`;
  }

  return normalized;
}
