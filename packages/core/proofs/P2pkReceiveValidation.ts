import { parseP2PKSecret, pointFromHex, type Secret } from '@cashu/cashu-ts';
import { ProofValidationError } from '../models/Error.ts';

/**
 * Resolve the supported original-key or unsigned path at preparation time.
 * An empty list means no witness is needed. The mint remains authoritative about time.
 */
export function getReceiveSigningKeys(secret: string, nowSeconds: number): string[] {
  let script: unknown;
  try {
    script = JSON.parse(secret);
  } catch {
    return [];
  }
  if (!Array.isArray(script) || script[0] !== 'P2PK') {
    throw new ProofValidationError('Only P2PK locking scripts are supported');
  }

  let parsed: Secret;
  try {
    parsed = parseP2PKSecret(secret);
  } catch (error) {
    throw new ProofValidationError(
      error instanceof Error ? error.message : 'Invalid P2PK spending condition',
    );
  }
  const tags = parsed[1].tags;
  if (tags !== undefined && !Array.isArray(tags)) {
    throw new ProofValidationError('Invalid P2PK tags');
  }
  const flag = readTag(parsed, 'sigflag');
  if (flag && (flag.length !== 1 || flag[0] !== 'SIG_INPUTS')) {
    throw new ProofValidationError('Only SIG_INPUTS P2PK receive is supported; SIG_ALL is not');
  }

  const additionalKeys = readKeys(parsed, 'pubkeys');
  const mainKeys = validateKeys([parsed[1].data, ...(additionalKeys ?? [])]);
  const refundKeys = readKeys(parsed, 'refund');
  const requiredSignatures = readThreshold(parsed, 'n_sigs', mainKeys.length);
  readThreshold(parsed, 'n_sigs_refund', refundKeys?.length ?? 0);

  // Invalid/missing locktime means permanent, never unlocked. Avoid parseInt's partial parsing
  // and cashu-ts 5.0.0-rc.4's >= expiry check: NUT-11 keeps the lock active at equality.
  const locktimeValues = readTag(parsed, 'locktime');
  const locktime = locktimeValues?.length === 1 ? parseInteger(locktimeValues[0]!) : undefined;
  const expired = locktime !== undefined && nowSeconds > locktime;
  if (expired && refundKeys === undefined) return [];

  // Refund conditions never make a proof unsigned. The original path remains valid after expiry.
  if (mainKeys.length !== 1 || requiredSignatures !== 1) {
    throw new ProofValidationError('Multisig is not supported');
  }
  return mainKeys;
}

function readKeys(secret: Secret, tag: 'pubkeys' | 'refund'): string[] | undefined {
  const keys = readTag(secret, tag);
  if (keys === undefined) return undefined;
  if (keys.length === 0) throw new ProofValidationError(`Empty P2PK ${tag} tag`);
  return validateKeys(keys);
}

// cashu-ts getTag treats a tag without values as absent. In particular, an empty refund tag
// must not turn an expired proof into an anyone-can-spend proof.
function readTag(secret: Secret, tag: string): string[] | undefined {
  return secret[1].tags?.find((entry) => entry[0] === tag)?.slice(1);
}

function validateKeys(keys: string[]): string[] {
  const normalized = keys.map((key) => {
    if (!/^0[23][0-9a-f]{64}$/i.test(key)) {
      throw new ProofValidationError('P2PK keys must be compressed secp256k1 public keys');
    }
    try {
      pointFromHex(key);
    } catch {
      throw new ProofValidationError('Invalid P2PK public key');
    }
    return key.toLowerCase();
  });
  if (new Set(normalized.map((key) => key.slice(2))).size !== normalized.length) {
    throw new ProofValidationError('Duplicate keys in P2PK spending path');
  }
  return normalized;
}

function parseInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function readThreshold(secret: Secret, tag: string, keyCount: number): number {
  const values = readTag(secret, tag);
  if (values === undefined) return 1;
  const value = values.length === 1 ? parseInteger(values[0]!) : undefined;
  if (value === undefined || value < 1 || value > keyCount) {
    throw new ProofValidationError(`Invalid P2PK ${tag} threshold`);
  }
  return value;
}
