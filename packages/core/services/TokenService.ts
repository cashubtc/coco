import type { Keyset } from '../models/Keyset';
import type { Logger } from '../logging/Logger';
import type { MintService } from './MintService';
import { getDecodedToken, type Token } from '@cashu/cashu-ts';
import { ProofValidationError, TokenValidationError } from '../models/Error';

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
  async decodeToken(token: Token | string, mintUrl: string): Promise<Token> {
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
      return typeof token === 'string' ? getDecodedToken(token, keysetIds) : token;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error during token decoding';
      this.logger?.warn('Failed to decode token', { token, mintUrl, err: errMsg });
      throw new ProofValidationError(errMsg);
    }
  }
}
