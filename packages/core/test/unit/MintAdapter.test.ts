import { Amount, type OutputData, type Proof } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MintAdapter } from '../../infra/MintAdapter.ts';
import type { MintRequestProvider } from '../../infra/MintRequestProvider.ts';

const mintUrl = 'https://mint.test';
const expiry = Math.floor(Date.now() / 1000) + 3600;
const mintInfo = {
  name: 'test mint',
  pubkey: 'pubkey',
  version: '1.0.0',
  contact: [],
  nuts: {
    '4': { methods: [], disabled: false },
    '5': { methods: [], disabled: false },
  },
};
const keysets = { keysets: [{ id: 'keyset-1', unit: 'sat', active: true }] };
const onchainMintQuote = {
  quote: 'mint-quote',
  request: 'bc1ptest',
  method: 'onchain',
  unit: 'sat',
  expiry,
  pubkey: 'quote-pubkey',
  amount_paid: Amount.from(10),
  amount_issued: Amount.zero(),
  updated_at: null,
};
const bolt11MeltQuote = {
  quote: 'melt-11',
  request: 'lnbc1melt',
  method: 'bolt11',
  amount: Amount.from(10),
  unit: 'sat',
  expiry,
  fee_reserve: Amount.from(1),
  state: 'PAID' as const,
  payment_preimage: 'preimage',
};
const bolt12MeltQuote = {
  quote: 'melt-12',
  request: 'lno1offer',
  method: 'bolt12',
  amount: Amount.from(10),
  unit: 'sat',
  expiry,
  fee_reserve: Amount.from(1),
  state: 'PENDING' as const,
  payment_preimage: null,
};
const onchainMeltQuote = {
  quote: 'melt-onchain',
  request: 'bc1ptest',
  method: 'onchain',
  amount: Amount.from(10),
  unit: 'sat',
  expiry,
  fee_options: [{ fee_index: 7, fee_reserve: Amount.from(2), estimated_blocks: 6 }],
  selected_fee_index: null,
  state: 'UNPAID' as const,
  outpoint: null,
};

type FakeCashuMint = {
  getInfo: ReturnType<typeof mock>;
  getKeySets: ReturnType<typeof mock>;
  getKeys: ReturnType<typeof mock>;
  checkMintQuote: ReturnType<typeof mock>;
  checkMeltQuoteBolt11: ReturnType<typeof mock>;
  checkMeltQuoteBolt12: ReturnType<typeof mock>;
  checkMeltQuoteOnchain: ReturnType<typeof mock>;
  check: ReturnType<typeof mock>;
  meltBolt11: ReturnType<typeof mock>;
  meltBolt12: ReturnType<typeof mock>;
  meltOnchain: ReturnType<typeof mock>;
};

function installFakeMint(adapter: MintAdapter, fakeMint: FakeCashuMint): void {
  (adapter as unknown as { cashuMints: Record<string, FakeCashuMint> }).cashuMints[mintUrl] =
    fakeMint;
}

describe('MintAdapter', () => {
  let adapter: MintAdapter;
  let requestProvider: MintRequestProvider;
  let fakeMint: FakeCashuMint;

  beforeEach(() => {
    requestProvider = {
      getRequestFn: mock(() => async () => new Response('{}')),
    } as unknown as MintRequestProvider;
    adapter = new MintAdapter(requestProvider);
    fakeMint = {
      getInfo: mock(async () => mintInfo),
      getKeySets: mock(async () => keysets),
      getKeys: mock(async () => ({ keysets: [{ keys: { '1': 'pubkey' } }] })),
      checkMintQuote: mock(async () => onchainMintQuote),
      checkMeltQuoteBolt11: mock(async () => bolt11MeltQuote),
      checkMeltQuoteBolt12: mock(async () => bolt12MeltQuote),
      checkMeltQuoteOnchain: mock(async () => onchainMeltQuote),
      check: mock(async () => ({ states: [{ Y: 'Y1', state: 'UNSPENT', witness: null }] })),
      meltBolt11: mock(async () => bolt11MeltQuote),
      meltBolt12: mock(async () => bolt12MeltQuote),
      meltOnchain: mock(async () => ({ ...onchainMeltQuote, state: 'PENDING' as const })),
    };
    installFakeMint(adapter, fakeMint);
  });

  it('manages mint auth providers and invalidates cached mint instances', () => {
    const provider = {
      getBlindAuthToken: mock(async () => 'blind-auth-token'),
      getCAT: mock(() => undefined),
      setCAT: mock(() => undefined),
    };

    adapter.setAuthProvider(mintUrl, provider);
    expect(adapter.getAuthProvider(mintUrl)).toBe(provider);
    expect(
      (adapter as unknown as { cashuMints: Record<string, FakeCashuMint> }).cashuMints[mintUrl],
    ).toBeUndefined();

    installFakeMint(adapter, fakeMint);
    adapter.clearAuthProvider(mintUrl);

    expect(adapter.getAuthProvider(mintUrl)).toBeUndefined();
    expect(
      (adapter as unknown as { cashuMints: Record<string, FakeCashuMint> }).cashuMints[mintUrl],
    ).toBeUndefined();
  });

  it('delegates mint metadata and quote checks to the cached Cashu mint', async () => {
    await expect(adapter.fetchMintInfo(mintUrl)).resolves.toEqual(mintInfo);
    await expect(adapter.fetchKeysets(mintUrl)).resolves.toEqual(keysets);
    await expect(adapter.fetchKeysForId(mintUrl, 'keyset-1')).resolves.toEqual({ '1': 'pubkey' });
    await expect(adapter.checkMintQuote(mintUrl, 'onchain', 'mint-quote')).resolves.toEqual(
      onchainMintQuote,
    );

    expect(fakeMint.getKeys).toHaveBeenCalledWith('keyset-1');
    expect(fakeMint.checkMintQuote).toHaveBeenCalledWith('onchain', 'mint-quote');
  });

  it('rejects key lookups that return anything other than one keyset', async () => {
    fakeMint.getKeys = mock(async () => ({ keysets: [] }));

    await expect(adapter.fetchKeysForId(mintUrl, 'missing-keyset')).rejects.toThrow(
      'Expected 1 keyset',
    );
  });

  it('delegates melt quote checks and state-only helpers', async () => {
    await expect(adapter.checkMeltQuote(mintUrl, 'melt-11')).resolves.toEqual(bolt11MeltQuote);
    await expect(adapter.checkMeltQuoteBolt12(mintUrl, 'melt-12')).resolves.toEqual(
      bolt12MeltQuote,
    );
    await expect(adapter.checkMeltQuoteOnchain(mintUrl, 'melt-onchain')).resolves.toEqual(
      onchainMeltQuote,
    );
    await expect(adapter.checkMeltQuoteState(mintUrl, 'melt-11')).resolves.toBe('PAID');
    await expect(adapter.checkMeltQuoteBolt12State(mintUrl, 'melt-12')).resolves.toBe('PENDING');
    await expect(adapter.checkMeltQuoteOnchainState(mintUrl, 'melt-onchain')).resolves.toBe(
      'UNPAID',
    );

    expect(fakeMint.checkMeltQuoteBolt11).toHaveBeenCalledWith('melt-11');
    expect(fakeMint.checkMeltQuoteBolt12).toHaveBeenCalledWith('melt-12');
    expect(fakeMint.checkMeltQuoteOnchain).toHaveBeenCalledWith('melt-onchain');
  });

  it('delegates proof state checks and custom melt calls with blinded change outputs', async () => {
    const proof = { amount: Amount.from(1), id: 'keyset-1', secret: 'secret', C: 'C' } as Proof;
    const output = { blindedMessage: { amount: Amount.from(1), id: 'keyset-1', B_: 'B_' } };

    await expect(adapter.checkProofStates(mintUrl, ['Y1'])).resolves.toEqual([
      { Y: 'Y1', state: 'UNSPENT', witness: null },
    ]);
    await expect(
      adapter.customMeltBolt11(mintUrl, [proof], [output as OutputData], 'melt-11'),
    ).resolves.toEqual(bolt11MeltQuote);
    await expect(
      adapter.customMeltBolt12(mintUrl, [proof], [output as OutputData], 'melt-12'),
    ).resolves.toEqual(bolt12MeltQuote);
    await expect(
      adapter.customMeltOnchain(mintUrl, [proof], [output as OutputData], 'melt-onchain', 7),
    ).resolves.toEqual({ ...onchainMeltQuote, state: 'PENDING' });

    expect(fakeMint.check).toHaveBeenCalledWith({ Ys: ['Y1'] });
    expect(fakeMint.meltBolt11).toHaveBeenCalledWith({
      quote: 'melt-11',
      inputs: [proof],
      outputs: [output.blindedMessage],
    });
    expect(fakeMint.meltBolt12).toHaveBeenCalledWith({
      quote: 'melt-12',
      inputs: [proof],
      outputs: [output.blindedMessage],
    });
    expect(fakeMint.meltOnchain).toHaveBeenCalledWith({
      quote: 'melt-onchain',
      inputs: [proof],
      outputs: [output.blindedMessage],
      fee_index: 7,
      prefer_async: true,
    });
  });
});
