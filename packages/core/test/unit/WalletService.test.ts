import { deriveKeysetId } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';

import type { Keyset } from '../../models/Keyset.ts';
import type { Mint } from '../../models/Mint.ts';
import { WalletService } from '../../services/WalletService.ts';
import type { MintInfo } from '../../types.ts';

const mintUrl = 'https://mint.test';

const mintInfo: MintInfo = {
  name: 'Test Mint',
  version: '1.0.0',
  pubkey: 'test-pubkey',
  contact: [],
  nuts: {
    '4': { methods: [], disabled: false },
    '5': { methods: [], disabled: false },
  },
} as MintInfo;

const keypairs = {
  '1': '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  '2': '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
  '4': '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
  '8': '03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb',
};

function makeMint(url = mintUrl): Mint {
  return {
    mintUrl: url,
    name: url,
    mintInfo,
    trusted: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeKeyset(unit: string): Keyset {
  return {
    mintUrl,
    id: deriveKeysetId(keypairs, { unit }),
    unit,
    keypairs,
    active: true,
    feePpk: 0,
    updatedAt: 0,
  };
}

function makeService(keysets: Keyset[]) {
  const ensureUpdatedMint = mock(async (url: string) => ({
    mint: makeMint(url),
    keysets: keysets.map((keyset) => ({ ...keyset, mintUrl: url })),
  }));
  const updateMintData = mock(async (url: string) => ({
    mint: makeMint(url),
    keysets: keysets.map((keyset) => ({ ...keyset, mintUrl: url })),
  }));
  const getSeed = mock(async () => new Uint8Array(64).fill(1));
  const getRequestFn = mock(
    () =>
      async <T>() =>
        ({}) as T,
  );

  const service = new WalletService(
    { ensureUpdatedMint, updateMintData } as any,
    { getSeed } as any,
    { getRequestFn } as any,
  );

  return { service, ensureUpdatedMint, updateMintData, getRequestFn };
}

describe('WalletService unit scoping', () => {
  it('builds sat wallets when sat is requested explicitly', async () => {
    const { service } = makeService([makeKeyset('sat')]);

    const wallet = await service.getWallet(mintUrl, 'sat');

    expect(wallet.unit).toBe('sat');
  });

  it('builds and caches separate wallets per mint unit', async () => {
    const { service, ensureUpdatedMint } = makeService([makeKeyset('sat'), makeKeyset('usd')]);

    const satWallet = await service.getWallet(mintUrl, 'sat');
    const usdWallet = await service.getWallet(mintUrl, 'USD');
    const cachedUsdWallet = await service.getWallet(mintUrl, 'usd');

    expect(satWallet.unit).toBe('sat');
    expect(usdWallet.unit).toBe('usd');
    expect(usdWallet).toBe(cachedUsdWallet);
    expect(satWallet).not.toBe(usdWallet);
    expect(ensureUpdatedMint).toHaveBeenCalledTimes(2);
  });

  it('returns the active keyset for the requested unit', async () => {
    const { service } = makeService([makeKeyset('sat'), makeKeyset('usd')]);

    const result = await service.getWalletWithActiveKeysetId(mintUrl, 'USD');

    expect(result.unit).toBe('usd');
    expect(result.keyset.unit).toBe('usd');
    expect(result.keys.unit).toBe('usd');
  });

  it('throws when the requested unit has no keysets', async () => {
    const { service } = makeService([makeKeyset('sat')]);

    await expect(service.getWallet(mintUrl, 'usd')).rejects.toThrow(
      'No valid keysets found for mint https://mint.test and unit usd',
    );
  });

  it('can clear one unit cache without clearing other units', async () => {
    const { service, ensureUpdatedMint } = makeService([makeKeyset('sat'), makeKeyset('usd')]);

    const satWallet = await service.getWallet(mintUrl, 'sat');
    const usdWallet = await service.getWallet(mintUrl, 'usd');
    service.clearCache(mintUrl, 'sat');

    const rebuiltSatWallet = await service.getWallet(mintUrl, 'sat');
    const cachedUsdWallet = await service.getWallet(mintUrl, 'usd');

    expect(rebuiltSatWallet).not.toBe(satWallet);
    expect(cachedUsdWallet).toBe(usdWallet);
    expect(ensureUpdatedMint).toHaveBeenCalledTimes(3);
  });
});
