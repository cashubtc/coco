import { getDecodedToken, getTokenMetadata, isBlsKeyset, type Token } from '@cashu/cashu-ts';
import type { Keyset } from '@core/models/Keyset.ts';
import { ProofValidationError, TokenValidationError } from '@core/models/Error.ts';
import { DEFAULT_UNIT, assertSameUnit, normalizeUnit } from '@core/amounts.ts';

/** Decode and resolve units using supplied metadata. Never refreshes or persists a mint. */
export function decodeTokenWithKeysets(
  token: Token | string,
  keysets: readonly Keyset[],
  expectedUnit?: string,
): Token {
  try {
    const keysetIds = keysets.map((keyset) => keyset.id);
    const decoded = typeof token === 'string' ? getDecodedToken(token, keysetIds) : token;
    const decodedForUnitResolution =
      typeof token === 'string' && !encodedTokenMetadataHasExplicitUnit(token)
        ? { ...decoded, unit: undefined }
        : decoded;
    if (decoded.proofs.some((proof) => isBlsKeyset(proof.id))) {
      throw new ProofValidationError('BLS v3 keysets are not supported');
    }
    const unit = resolveTokenUnit(decodedForUnitResolution, keysets, expectedUnit);
    return { ...decoded, unit };
  } catch (error) {
    throw new ProofValidationError(
      error instanceof Error ? error.message : 'Unknown error during token decoding',
    );
  }
}

function resolveTokenUnit(token: Token, keysets: readonly Keyset[], expectedUnit?: string): string {
  const keysetUnits = new Map(
    keysets.map((keyset) => [
      keyset.id,
      normalizeUnit(keyset.unit || DEFAULT_UNIT, { defaultUnit: DEFAULT_UNIT }),
    ]),
  );
  const resolvedProofUnits = token.proofs
    .map((proof) => keysetUnits.get(proof.id))
    .filter((unit): unit is string => unit !== undefined);
  const uniqueProofUnits = Array.from(new Set(resolvedProofUnits));

  if (uniqueProofUnits.length > 1) {
    throw new TokenValidationError(
      `Token contains proofs from multiple units: ${uniqueProofUnits.join(', ')}`,
    );
  }

  const tokenUnit =
    token.unit === undefined || token.unit === null
      ? undefined
      : normalizeUnit(token.unit, { defaultUnit: DEFAULT_UNIT });
  const resolvedUnit = tokenUnit ?? uniqueProofUnits[0] ?? DEFAULT_UNIT;

  if (tokenUnit && uniqueProofUnits[0]) {
    assertSameUnit(uniqueProofUnits[0], tokenUnit, 'Token proof keysets');
  }
  if (expectedUnit !== undefined) {
    assertSameUnit(resolvedUnit, expectedUnit, 'Token');
  }

  return resolvedUnit;
}
function encodedTokenMetadataHasExplicitUnit(token: string): boolean {
  try {
    const metadata = getTokenMetadata(token);

    if (metadata.unit === undefined || metadata.unit === null) {
      return false;
    }

    if (isLegacyTokenWithoutUnit(token)) {
      return false;
    }

    return true;
  } catch {
    return true;
  }
}

function stripCashuTokenPrefix(token: string): string {
  for (const prefix of ['web+cashu://', 'cashu://', 'cashu:']) {
    if (token.startsWith(prefix)) {
      return stripCashuTokenPrefix(token.slice(prefix.length));
    }
  }
  return token.startsWith('cashu') ? token.slice(5) : token;
}

function decodeBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    if (char === '=') {
      break;
    }
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new Error('Invalid base64url character');
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return Uint8Array.from(bytes);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function isLegacyTokenWithoutUnit(token: string): boolean {
  const payload = stripCashuTokenPrefix(token);
  if (payload.slice(0, 1) !== 'A') {
    return false;
  }

  const body = payload.slice(1);
  const json = new TextDecoder().decode(decodeBase64Url(body));
  const decoded = JSON.parse(json) as Record<string, unknown>;
  return !Object.prototype.hasOwnProperty.call(decoded, 'unit');
}
