import {
  Amount,
  deriveKeysetId,
  OutputData,
  type OutputDataCreator,
  type OutputDataLike,
} from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';

import type { Keyset } from '../../models/Keyset.ts';
import type { Mint } from '../../models/Mint.ts';
import { WalletService } from '../../services/WalletService.ts';
import type { MintInfo } from '../../types.ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';

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

function makeService(keysets: Keyset[], outputDataCreator?: OutputDataCreator) {
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
    undefined,
    undefined,
    outputDataCreator,
  );

  return { service, ensureUpdatedMint, updateMintData, getRequestFn };
}

describe('WalletService unit scoping', () => {
  it('uses the supplied creator when a Wallet Instance prepares outputs', async () => {
    const output = {
      blindedMessage: { amount: Amount.from(1), id: 'custom-keyset', B_: 'custom-blinded' },
      blindingFactor: 7n,
      secret: new Uint8Array([1, 2, 3]),
      toProof: mock(() => {
        throw new Error('not used while preparing');
      }),
    } satisfies OutputDataLike;
    const createRandomData = mock(() => [output]);
    const creator = makeOutputDataCreator({ createRandomData });
    const { service } = makeService([makeKeyset('sat')], creator);
    const wallet = await service.getWallet(mintUrl, 'sat');

    const preview = await wallet.prepareMint(
      'bolt11',
      Amount.from(1),
      {
        quote: 'quote-1',
        request: 'lnbc1test',
        unit: 'sat',
        amount: Amount.from(1),
        state: 'PAID',
        expiry: null,
      },
      undefined,
      { type: 'random' },
    );

    expect(createRandomData).toHaveBeenCalledTimes(1);
    expect(preview.outputData).toEqual([output]);
  });

  it('uses the supplied creator for Wallet Instance restore output generation', async () => {
    const output = {
      blindedMessage: { amount: Amount.zero(), id: 'custom-keyset', B_: 'custom-restore' },
      blindingFactor: 11n,
      secret: new Uint8Array([4, 5, 6]),
      toProof: mock(() => {
        throw new Error('not used when the mint returns no signatures');
      }),
    } satisfies OutputDataLike;
    const createDeterministicData = mock(() => [output]);
    const creator = makeOutputDataCreator({ createDeterministicData });
    const keyset = makeKeyset('sat');
    const { service } = makeService([keyset], creator);
    const wallet = await service.getWallet(mintUrl, 'sat');
    wallet.mint.restore = mock(async () => ({ outputs: [], signatures: [] }));
    const originalCreateDeterministicData = OutputData.createDeterministicData;
    OutputData.createDeterministicData = () => {
      throw new Error('built-in deterministic creation must not be used');
    };

    try {
      await wallet.restore(5, 1, { keysetId: keyset.id });
    } finally {
      OutputData.createDeterministicData = originalCreateDeterministicData;
    }

    expect(createDeterministicData).toHaveBeenCalledWith(
      0,
      new Uint8Array(64).fill(1),
      5,
      expect.objectContaining({ id: keyset.id }),
      [0],
    );
    expect(wallet.mint.restore).toHaveBeenCalledWith({
      outputs: [output.blindedMessage],
    });
  });

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

  it('does not build a Wallet Instance from v3 keysets', async () => {
    const v3Keyset = { ...makeKeyset('sat'), id: '0200000000000000' };
    const { service } = makeService([v3Keyset]);

    await expect(service.getWallet(mintUrl, 'sat')).rejects.toThrow(
      'No valid keysets found for mint https://mint.test and unit sat',
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
