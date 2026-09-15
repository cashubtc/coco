import { Amount, type Token } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';
import { TokenService } from '../../services/TokenService.ts';
import type { MintService } from '../../services/MintService.ts';
import { ProofValidationError } from '../../models/Error.ts';

describe('TokenService', () => {
  const mintUrl = 'https://mint.test';

  it('resolves an unknown token keyset and its unit from one forced refresh', async () => {
    const mintService = {
      ensureUpdatedMint: mock(async () => ({ mint: { mintUrl }, keysets: [] })),
      updateMintData: mock(async () => ({
        mint: { mintUrl },
        keysets: [{ id: 'new-keyset', unit: 'usd' }],
      })),
    } as unknown as MintService;
    const token: Token = {
      mint: mintUrl,
      proofs: [{ id: 'new-keyset', amount: Amount.from(1), secret: 'secret', C: 'C' }],
    };
    expect((await new TokenService(mintService).decodeToken(token, mintUrl)).unit).toBe('usd');
    expect(mintService.updateMintData).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown proof keysets after one forced refresh', async () => {
    const mintService = {
      updateMintData: mock(async () => ({ mint: { mintUrl }, keysets: [] })),
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

    await expect(service.decodeToken(token, mintUrl)).rejects.toThrow('unknown to this mint');
    expect(mintService.updateMintData).toHaveBeenCalledTimes(1);
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
