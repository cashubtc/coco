import { Amount, type Token } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';
import { TokenService } from '../../services/TokenService.ts';
import type { MintService } from '../../services/MintService.ts';
import { MintFetchError, TokenValidationError } from '../../models/Error.ts';

describe('TokenService', () => {
  const mintUrl = 'https://mint.test';

  it('falls back to sat when a unitless token has no resolvable keyset metadata', async () => {
    const mintService = {
      ensureUpdatedMint: mock(async () => ({
        mint: { mintUrl },
        keysets: [],
      })),
    } as unknown as MintService;
    const service = new TokenService(mintService);
    const token: Token = {
      mint: mintUrl,
      proofs: [
        {
          id: 'missing-keyset',
          amount: Amount.from(1),
          secret: 'secret-1',
          C: 'C-1',
        },
      ],
    };

    const decoded = await service.decodeToken(token, mintUrl);

    expect(decoded.unit).toBe('sat');
  });

  it('decodes with cached keysets when the mint refresh fails for a known mint', async () => {
    const mintService = {
      ensureUpdatedMint: mock(async () => {
        throw new MintFetchError(mintUrl, 'Failed to fetch mint info');
      }),
      getKnownMintWithKeysets: mock(async () => ({
        mint: { mintUrl },
        keysets: [{ id: 'keyset-1', mintUrl, unit: 'usd', active: true, feePpk: 0 }],
      })),
    } as unknown as MintService;
    const service = new TokenService(mintService);
    const token: Token = {
      mint: mintUrl,
      proofs: [
        {
          id: 'keyset-1',
          amount: Amount.from(1),
          secret: 'secret-1',
          C: 'C-1',
        },
      ],
    };

    const decoded = await service.decodeToken(token, mintUrl);

    expect(decoded.unit).toBe('usd');
  });

  it('preserves the mint fetch failure as cause when no cached keysets exist', async () => {
    const fetchError = new MintFetchError(mintUrl, 'Failed to fetch mint info');
    const mintService = {
      ensureUpdatedMint: mock(async () => {
        throw fetchError;
      }),
      getKnownMintWithKeysets: mock(async () => null),
    } as unknown as MintService;
    const service = new TokenService(mintService);
    const token: Token = {
      mint: mintUrl,
      proofs: [
        {
          id: 'keyset-1',
          amount: Amount.from(1),
          secret: 'secret-1',
          C: 'C-1',
        },
      ],
    };

    try {
      await service.decodeToken(token, mintUrl);
      throw new Error('Expected decodeToken to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(TokenValidationError);
      expect((error as { cause?: unknown }).cause).toBe(fetchError);
    }
  });
});
