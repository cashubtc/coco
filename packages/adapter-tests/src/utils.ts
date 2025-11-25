/**
 * BOLT11 Fake Invoice Generator
 *
 * Generates fake but spec-compliant BOLT11 invoices for testing purposes.
 * Based on BOLT #11: Invoice Protocol for Lightning Payments
 * https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';

// Bech32 character set
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// Generator polynomial for bech32
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/**
 * Compute bech32 checksum
 */
function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) {
        chk ^= BECH32_GENERATOR[i]!;
      }
    }
  }
  return chk;
}

/**
 * Expand the human-readable part for checksum calculation
 */
function bech32HrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) >> 5);
  }
  result.push(0);
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) & 31);
  }
  return result;
}

/**
 * Create bech32 checksum
 */
function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const polymod = bech32Polymod(values) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((polymod >> (5 * (5 - i))) & 31);
  }
  return checksum;
}

/**
 * Encode data to bech32 string
 */
function bech32Encode(hrp: string, data: number[]): string {
  const checksum = bech32CreateChecksum(hrp, data);
  const combined = data.concat(checksum);
  let result = hrp + '1';
  for (const d of combined) {
    result += BECH32_CHARSET[d];
  }
  return result;
}

/**
 * Convert a byte array to 5-bit groups
 */
function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new Error('Invalid bit conversion');
  }

  return result;
}

/**
 * Convert 5-bit groups back to bytes
 */
function convertBitsToBytes(data: number[]): Uint8Array {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];

  for (const value of data) {
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      result.push((acc >> bits) & 0xff);
    }
  }

  return new Uint8Array(result);
}

/**
 * Encode a number to 5-bit groups with specified length
 */
function encodeNumber(num: number, length: number): number[] {
  const result: number[] = [];
  for (let i = length - 1; i >= 0; i--) {
    result.push((num >> (i * 5)) & 31);
  }
  return result;
}

/**
 * Generate a random hex string of specified length (in bytes)
 */
function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Encode a tagged field
 * Format: type (5 bits) + data_length (10 bits) + data
 */
function encodeTaggedField(type: string, data: number[]): number[] {
  const typeValue = BECH32_CHARSET.indexOf(type);
  const length = data.length;
  // Length is encoded as two 5-bit values (10 bits total)
  const lengthHigh = (length >> 5) & 31;
  const lengthLow = length & 31;
  return [typeValue, lengthHigh, lengthLow, ...data];
}

export type FakeInvoiceOptions = {
  /** Network prefix: 'bc' for mainnet, 'tb' for testnet, 'bcrt' for regtest. Default: 'bcrt' */
  network?: 'bc' | 'tb' | 'bcrt' | 'tbs';
  /** Description string. Default: 'Test invoice' */
  description?: string;
  /** Expiry in seconds. Default: 3600 (1 hour) */
  expiry?: number;
  /** Payment hash (32 bytes hex). Default: random */
  paymentHash?: string;
  /** Payment secret (32 bytes hex). Default: random */
  paymentSecret?: string;
  /** Timestamp in seconds since epoch. Default: current time */
  timestamp?: number;
  /** Private key for signing (32 bytes hex). Default: random */
  privateKey?: string;
};

/**
 * Creates a fake but spec-compliant BOLT11 invoice for testing purposes.
 *
 * The generated invoice follows the BOLT11 specification with a valid cryptographic
 * signature. It can be used for testing melt quote creation and payment flows.
 *
 * Note: While the invoice has a valid signature, it cannot actually be paid on a
 * real Lightning Network since the destination node doesn't exist.
 *
 * @param amountSats - Amount in satoshis
 * @param options - Optional configuration
 * @returns A BOLT11 encoded invoice string
 *
 * @example
 * ```ts
 * const invoice = createFakeInvoice(100);
 * // Returns: lnbcrt1u1p...
 * ```
 */
export function createFakeInvoice(amountSats: number, options: FakeInvoiceOptions = {}): string {
  const {
    network = 'bc',
    description = 'Test invoice',
    expiry = 3600,
    paymentHash = randomHex(32),
    paymentSecret = randomHex(32),
    timestamp = Math.floor(Date.now() / 1000),
    privateKey = randomHex(32),
  } = options;

  // Build human-readable part: ln + network + amount
  // Amount encoding: use the smallest multiplier that results in an integer
  let amountStr: string;
  const amountMsat = amountSats * 1000;

  if (amountMsat % 100000000000 === 0) {
    // Can express in BTC
    amountStr = String(amountMsat / 100000000000);
  } else if (amountMsat % 100000000 === 0) {
    // Can express in milli-BTC
    amountStr = String(amountMsat / 100000000) + 'm';
  } else if (amountMsat % 100000 === 0) {
    // Can express in micro-BTC
    amountStr = String(amountMsat / 100000) + 'u';
  } else if (amountMsat % 100 === 0) {
    // Can express in nano-BTC
    amountStr = String(amountMsat / 100) + 'n';
  } else {
    // Must use pico-BTC (msat * 10)
    amountStr = String(amountMsat * 10) + 'p';
  }

  const hrp = `ln${network}${amountStr}`;

  // Build data part (without signature)
  const data: number[] = [];

  // Timestamp: 35 bits (7 x 5-bit groups)
  data.push(...encodeNumber(timestamp, 7));

  // Tagged fields:

  // Payment hash (p): 52 x 5-bit groups = 260 bits = 32.5 bytes, we use 32 bytes
  const paymentHashBytes = hexToBytes(paymentHash);
  const paymentHashData = convertBits(paymentHashBytes, 8, 5, true);
  data.push(...encodeTaggedField('p', paymentHashData));

  // Payment secret (s): 52 x 5-bit groups
  const paymentSecretBytes = hexToBytes(paymentSecret);
  const paymentSecretData = convertBits(paymentSecretBytes, 8, 5, true);
  data.push(...encodeTaggedField('s', paymentSecretData));

  // Description (d): variable length
  const descriptionBytes = new TextEncoder().encode(description);
  const descriptionData = convertBits(descriptionBytes, 8, 5, true);
  data.push(...encodeTaggedField('d', descriptionData));

  // Expiry (x): variable length
  // Find minimum number of 5-bit groups needed
  let expiryBits = 5;
  while (1 << expiryBits <= expiry) {
    expiryBits += 5;
  }
  const expiryGroups = Math.ceil(expiryBits / 5);
  const expiryData = encodeNumber(expiry, expiryGroups);
  data.push(...encodeTaggedField('x', expiryData));

  // Feature bits (9): basic features
  // Set bit 8 (var_onion_optin) and bit 14 (payment_secret) as required
  // Binary: 0100000100000000 (reading right to left, bits 8 and 14)
  // Encoded as 5-bit groups: [0, 16, 8, 0]
  const featureData = [0, 16, 8, 0];
  data.push(...encodeTaggedField('9', featureData));

  // Create the message to sign
  // From BOLT11 spec: signature is over SHA256 of (hrp as UTF-8 bytes + data part as bytes)
  // The data is converted from 5-bit groups to 8-bit bytes, with 0 bits padding if needed
  const hrpBytes = new TextEncoder().encode(hrp);
  const dataBytes = convertBitsToBytes(data);

  // Concatenate hrp and data bytes
  const messageBytes = new Uint8Array(hrpBytes.length + dataBytes.length);
  messageBytes.set(hrpBytes, 0);
  messageBytes.set(dataBytes, hrpBytes.length);

  // Hash the message
  const messageHash = sha256(messageBytes);

  // Sign with secp256k1
  const privKeyBytes = hexToBytes(privateKey);
  const signature = secp256k1.sign(messageHash, privKeyBytes);

  // Build the signature bytes: 64 bytes R||S + 1 byte recovery id
  const sigBytes = new Uint8Array(65);
  sigBytes.set(signature.toCompactRawBytes(), 0);
  sigBytes[64] = signature.recovery;

  // Convert signature to 5-bit groups and append to data
  const signatureData = convertBits(sigBytes, 8, 5, true);
  data.push(...signatureData);

  return bech32Encode(hrp, data);
}

/**
 * @deprecated Use createFakeInvoice instead. This function creates invoices from the mint
 * which cannot be paid back to the same mint.
 */
export async function createInvoice(amount: number, mintUrl: string): Promise<string> {
  // For backwards compatibility, use the fake invoice generator
  const invoice = createFakeInvoice(amount);
  console.log('invoice', invoice);
  return invoice;
}
