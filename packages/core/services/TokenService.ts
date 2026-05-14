import type { Keyset } from '../models/Keyset';
import type { Logger } from '../logging/Logger';
import type { MintService } from './MintService';
import { getDecodedToken, type Token } from '@cashu/cashu-ts';
import { ProofValidationError, TokenValidationError } from '../models/Error';
import { DEFAULT_UNIT, assertSameUnit, normalizeUnit } from '../amounts.ts';

export class TokenService {
  private readonly mintService: MintService;
  private readonly logger?: Logger;

  constructor(mintService: MintService, logger?: Logger) {
    this.mintService = mintService;
    this.logger = logger;
  }

  /** Decode a token into a Token object using the mint's keysets for decoding.
   * @param token - The token to decode (can be a string or already decoded Token object)
   * @param mintUrl - The URL of the mint to use for fetching keysets for decoding
   * @returns The decoded Token object with proofs decoded using the mint's keysets
   */
  async decodeToken(token: Token | string, mintUrl: string, expectedUnit?: string): Promise<Token> {
    if (!token) {
      this.logger?.warn('No token provided for decoding', { token });
      throw new TokenValidationError('Token is required');
    }

    if (!mintUrl) {
      this.logger?.warn('No mint URL provided for token decoding', { token });
      throw new TokenValidationError('Mint URL is required for token decoding');
    }

    let mintKeysets: Keyset[];

    try {
      const { keysets } = await this.mintService.ensureUpdatedMint(mintUrl);
      mintKeysets = keysets;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unable to retrieve mint keysets';
      this.logger?.warn('Failed to get updated keysets for mint', {
        token,
        mintUrl,
        err: errMsg,
      });
      throw new TokenValidationError(errMsg);
    }

    try {
      const keysetIds = mintKeysets.map((keyset) => keyset.id);
      const decoded = typeof token === 'string' ? getDecodedToken(token, keysetIds) : token;
      const decodedForUnitResolution =
        typeof token === 'string' && !encodedTokenHasExplicitUnit(token)
          ? { ...decoded, unit: undefined }
          : decoded;
      const unit = this.resolveTokenUnit(decodedForUnitResolution, mintKeysets, expectedUnit);
      return { ...decoded, unit };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error during token decoding';
      this.logger?.warn('Failed to decode token', { token, mintUrl, err: errMsg });
      throw new ProofValidationError(errMsg);
    }
  }

  private resolveTokenUnit(token: Token, keysets: Keyset[], expectedUnit?: string): string {
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
}

function encodedTokenHasExplicitUnit(token: string): boolean {
  try {
    const payload = stripCashuTokenPrefix(token);
    const version = payload.slice(0, 1);
    const body = payload.slice(1);

    if (version === 'A') {
      const json = new TextDecoder().decode(decodeBase64Url(body));
      const decoded = JSON.parse(json) as Record<string, unknown>;
      return Object.prototype.hasOwnProperty.call(decoded, 'unit');
    }

    if (version === 'B') {
      return cborMapHasTextKey(decodeBase64Url(body), 'u');
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

function cborMapHasTextKey(bytes: Uint8Array, expectedKey: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readCborHeader(view, 0);
  if (header.majorType !== 5) {
    return false;
  }

  let offset = header.nextOffset;
  for (let index = 0; index < header.length; index++) {
    const key = readCborTextItem(view, offset);
    offset = key.nextOffset;
    if (key.value === expectedKey) {
      return true;
    }
    offset = skipCborItem(view, offset);
  }
  return false;
}

function readCborTextItem(view: DataView, offset: number): { value?: string; nextOffset: number } {
  const header = readCborHeader(view, offset);
  if (header.majorType !== 3) {
    return { nextOffset: skipCborItem(view, offset) };
  }

  const start = header.nextOffset;
  const end = start + header.length;
  if (end > view.byteLength) {
    throw new Error('Unexpected end of CBOR text item');
  }
  return {
    value: new TextDecoder().decode(
      new Uint8Array(view.buffer, view.byteOffset + start, header.length),
    ),
    nextOffset: end,
  };
}

function skipCborItem(view: DataView, offset: number): number {
  const header = readCborHeader(view, offset);

  if (header.majorType === 0 || header.majorType === 1 || header.majorType === 7) {
    return header.nextOffset;
  }

  if (header.majorType === 2 || header.majorType === 3) {
    const nextOffset = header.nextOffset + header.length;
    if (nextOffset > view.byteLength) {
      throw new Error('Unexpected end of CBOR byte/text item');
    }
    return nextOffset;
  }

  if (header.majorType === 4) {
    let nextOffset = header.nextOffset;
    for (let index = 0; index < header.length; index++) {
      nextOffset = skipCborItem(view, nextOffset);
    }
    return nextOffset;
  }

  if (header.majorType === 5) {
    let nextOffset = header.nextOffset;
    for (let index = 0; index < header.length; index++) {
      nextOffset = skipCborItem(view, nextOffset);
      nextOffset = skipCborItem(view, nextOffset);
    }
    return nextOffset;
  }

  if (header.majorType === 6) {
    return skipCborItem(view, header.nextOffset);
  }

  throw new Error(`Unsupported CBOR major type: ${header.majorType}`);
}

function readCborHeader(
  view: DataView,
  offset: number,
): { majorType: number; length: number; nextOffset: number } {
  if (offset >= view.byteLength) {
    throw new Error('Unexpected end of CBOR data');
  }

  const initialByte = view.getUint8(offset);
  const majorType = initialByte >> 5;
  const additionalInfo = initialByte & 0x1f;
  const length = readCborLength(view, offset + 1, additionalInfo);
  return { majorType, length: length.value, nextOffset: length.nextOffset };
}

function readCborLength(
  view: DataView,
  offset: number,
  additionalInfo: number,
): { value: number; nextOffset: number } {
  if (additionalInfo < 24) {
    return { value: additionalInfo, nextOffset: offset };
  }
  if (additionalInfo === 24) {
    ensureCborBytes(view, offset, 1);
    return { value: view.getUint8(offset), nextOffset: offset + 1 };
  }
  if (additionalInfo === 25) {
    ensureCborBytes(view, offset, 2);
    return { value: view.getUint16(offset), nextOffset: offset + 2 };
  }
  if (additionalInfo === 26) {
    ensureCborBytes(view, offset, 4);
    return { value: view.getUint32(offset), nextOffset: offset + 4 };
  }
  if (additionalInfo === 27) {
    ensureCborBytes(view, offset, 8);
    const value = view.getBigUint64(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('CBOR value exceeds safe integer range');
    }
    return { value: Number(value), nextOffset: offset + 8 };
  }
  throw new Error('Unsupported indefinite-length CBOR item');
}

function ensureCborBytes(view: DataView, offset: number, length: number): void {
  if (offset + length > view.byteLength) {
    throw new Error('Unexpected end of CBOR data');
  }
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
