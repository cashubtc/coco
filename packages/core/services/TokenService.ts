import { getDecodedToken, getTokenMetadata, isBlsKeyset, type Token } from '@cashu/cashu-ts';
import type { Keyset } from '../models/Keyset';
import type { Logger } from '../logging/Logger';
import type { MintService } from './MintService';
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
        typeof token === 'string' && !encodedTokenMetadataHasExplicitUnit(token)
          ? { ...decoded, unit: undefined }
          : decoded;
      if (decoded.proofs.some((proof) => isBlsKeyset(proof.id))) {
        throw new ProofValidationError('BLS v3 keysets are not supported');
      }
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
