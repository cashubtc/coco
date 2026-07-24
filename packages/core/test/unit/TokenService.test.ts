import { Amount, type Token } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';
import { TokenService } from '../../services/TokenService.ts';
import type { MintService } from '../../services/MintService.ts';
import { ProofValidationError } from '../../models/Error.ts';

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

  it('rejects tokens containing v3 proofs', async () => {
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
          id: '0200000000000000',
          amount: Amount.from(1),
          secret: 'secret-v3',
          C: 'C-v3',
        },
      ],
    };

    await expect(service.decodeToken(token, mintUrl)).rejects.toBeInstanceOf(ProofValidationError);
  });
});
