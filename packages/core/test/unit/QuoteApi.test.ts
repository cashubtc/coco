import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { QuoteApi } from '../../api/QuoteApi.ts';
import type { MeltOpsApi } from '../../api/MeltOpsApi.ts';
import type { GenericMeltQuote, MeltQuote } from '../../models/MeltQuote.ts';
import type { GenericMintQuote, MintQuote } from '../../models/MintQuote.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';

type MintCreateInput = Parameters<QuoteApi['mint']['create']>[0];
type MintImportInput = Parameters<QuoteApi['mint']['import']>[0];
type MeltCreateInput = Parameters<QuoteApi['melt']['create']>[0];
type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;

async function assertBuiltInAndGenericQuoteTypes(api: QuoteApi): Promise<void> {
  const bolt11MintQuote = await api.mint.create({
    mintUrl,
    method: 'bolt11',
    amount: Amount.from(10),
  });
  const bolt11MintMethod: 'bolt11' = bolt11MintQuote.method;
  const bolt12MintQuote = await api.mint.create({ mintUrl, method: 'bolt12', unit: 'sat' });
  const bolt12MintMethod: 'bolt12' = bolt12MintQuote.method;
  const onchainMintQuote = await api.mint.create({ mintUrl, method: 'onchain', unit: 'sat' });
  const onchainMintMethod: 'onchain' = onchainMintQuote.method;

  const genericMintQuote = await api.mint.createGeneric({
    mintUrl,
    method: 'fedimint',
    amount: Amount.from(10),
    payload: { memo: 'coffee' },
  });
  const genericMintMethod: 'fedimint' = genericMintQuote.method;
  type _AssertGenericMintQuote = Assert<
    IsNever<typeof genericMintQuote> extends false
      ? IsAny<typeof genericMintQuote> extends false
        ? typeof genericMintQuote extends GenericMintQuote<'fedimint'>
          ? true
          : false
        : false
      : false
  >;

  const bolt11MeltQuote = await api.melt.create({
    mintUrl,
    method: 'bolt11',
    methodData: { invoice: 'lnbc1melt' },
  });
  const bolt11MeltMethod: 'bolt11' = bolt11MeltQuote.method;

  const genericMeltQuote = await api.melt.createGeneric({
    mintUrl,
    method: 'gift-card',
    request: 'gift-card-request',
    payload: { destination: 'acct_123' },
  });
  const genericMeltMethod: 'gift-card' = genericMeltQuote.method;
  type _AssertGenericMeltQuote = Assert<
    IsNever<typeof genericMeltQuote> extends false
      ? IsAny<typeof genericMeltQuote> extends false
        ? typeof genericMeltQuote extends GenericMeltQuote<'gift-card'>
          ? true
          : false
        : false
      : false
  >;

  // @ts-expect-error Built-in mint methods must use the built-in quote creation API.
  await api.mint.createGeneric({ mintUrl, method: 'bolt11', amount: Amount.from(10) });
  // @ts-expect-error Built-in melt methods must use the built-in quote creation API.
  await api.melt.createGeneric({ mintUrl, method: 'onchain', request: 'bc1q...' });

  void [
    bolt11MintMethod,
    bolt12MintMethod,
    onchainMintMethod,
    genericMintMethod,
    bolt11MeltMethod,
    genericMeltMethod,
  ];
}

function assertMethodRequirementsRemain(): void {
  // @ts-expect-error Mint quote creation still requires method.
  const mintCreateWithoutMethod: MintCreateInput = { mintUrl, amount: Amount.from(10) };
  // @ts-expect-error Mint quote import still requires method.
  const mintImportWithoutMethod: MintImportInput = {
    mintUrl,
    quote: {
      quote: quoteId,
      request: 'lnbc1mint',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'UNPAID',
    },
  };
  // @ts-expect-error Melt quote creation still requires method.
  const meltCreateWithoutMethod: MeltCreateInput = {
    mintUrl,
    methodData: { invoice: 'lnbc1melt' },
  };
  void [mintCreateWithoutMethod, mintImportWithoutMethod, meltCreateWithoutMethod];
}

const makeMintQuote = (): MintQuote<'bolt11'> => ({
  mintUrl,
  method: 'bolt11',
  quoteId,
  quote: quoteId,
  request: 'lnbc1mint',
  amount: Amount.from(10),
  unit: 'sat',
  expiry: Math.floor(Date.now() / 1000) + 3600,
  state: 'UNPAID',
  lastObservedRemoteState: 'UNPAID',
  lastObservedRemoteStateAt: Date.now(),
  reusable: false,
  quoteData: {
    amount: Amount.from(10),
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const makeOnchainMintQuote = (): MintQuote<'onchain'> => ({
  mintUrl,
  method: 'onchain',
  quoteId,
  quote: quoteId,
  request: 'bc1qmint',
  unit: 'sat',
  expiry: Math.floor(Date.now() / 1000) + 3600,
  pubkey: 'pubkey',
  reusable: true,
  quoteData: {
    pubkey: 'pubkey',
    amountPaid: Amount.zero(),
    amountIssued: Amount.zero(),
  },
  lastObservedRemoteStateAt: Date.now(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const makeBolt12MintQuote = (): MintQuote<'bolt12'> => ({
  mintUrl,
  method: 'bolt12',
  quoteId,
  quote: quoteId,
  request: 'lno1mint',
  unit: 'sat',
  amount: Amount.from(10),
  expiry: Math.floor(Date.now() / 1000) + 3600,
  pubkey: 'pubkey',
  reusable: true,
  quoteData: {
    pubkey: 'pubkey',
    amount: Amount.from(10),
    amountPaid: Amount.zero(),
    amountIssued: Amount.zero(),
  },
  lastObservedRemoteStateAt: Date.now(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const makeMeltQuote = (): MeltQuote<'bolt11'> => ({
  mintUrl,
  method: 'bolt11',
  quoteId,
  quote: quoteId,
  request: 'lnbc1melt',
  amount: Amount.from(10),
  unit: 'sat',
  fee_reserve: Amount.from(1),
  expiry: Math.floor(Date.now() / 1000) + 3600,
  state: 'UNPAID',
  payment_preimage: null,
  lastObservedRemoteState: 'UNPAID',
  lastObservedRemoteStateAt: Date.now(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe('QuoteApi', () => {
  let api: QuoteApi;
  let quoteLifecycle: QuoteLifecycle;
  let mintQuote: MintQuote<'bolt11'>;
  let meltQuote: MeltQuote<'bolt11'>;

  beforeEach(() => {
    mintQuote = makeMintQuote();
    meltQuote = makeMeltQuote();
    quoteLifecycle = {
      createMintQuote: mock(async () => mintQuote),
      importMintQuote: mock(async () => mintQuote),
      getMintQuoteById: mock(async () => mintQuote),
      getPendingMintQuotes: mock(async () => [mintQuote]),
      refreshMintQuoteById: mock(async () => ({ ...mintQuote, state: 'PAID' })),
      createMeltQuote: mock(async () => meltQuote),
      getMeltQuoteById: mock(async () => meltQuote),
      getPendingMeltQuotes: mock(async () => [meltQuote]),
      refreshMeltQuoteById: mock(async () => ({ ...meltQuote, state: 'PENDING' })),
    } as unknown as QuoteLifecycle;

    api = new QuoteApi(quoteLifecycle);
  });

  it('delegates mint quote methods', async () => {
    await expect(
      api.mint.create({ mintUrl, amount: Amount.from(10), method: 'bolt11' }),
    ).resolves.toBe(mintQuote);
    await expect(api.mint.get({ mintUrl, quoteId })).resolves.toBe(mintQuote);
    await expect(
      api.mint.import({
        mintUrl,
        method: 'bolt11',
        quote: {
          quote: quoteId,
          request: 'lnbc1mint',
          amount: Amount.from(10),
          unit: 'sat',
          expiry: mintQuote.expiry,
          state: 'UNPAID',
        },
      }),
    ).resolves.toBe(mintQuote);
    await expect(api.mint.listPending({ method: 'bolt11' })).resolves.toEqual([mintQuote]);
    await expect(api.mint.refresh({ mintUrl, quoteId })).resolves.toMatchObject({
      state: 'PAID',
    });

    expect(quoteLifecycle.createMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', {
      amount: { amount: Amount.from(10), unit: 'sat' },
    });
    expect(quoteLifecycle.importMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', {
      quote: quoteId,
      request: 'lnbc1mint',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: mintQuote.expiry,
      state: 'UNPAID',
    });
    expect(quoteLifecycle.getMintQuoteById).toHaveBeenCalledWith({ mintUrl, quoteId });
    expect(quoteLifecycle.getPendingMintQuotes).toHaveBeenCalledWith('bolt11');
    expect(quoteLifecycle.refreshMintQuoteById).toHaveBeenCalledWith({ mintUrl, quoteId });
  });

  it('delegates onchain mint quote creation without an amount', async () => {
    const onchainQuote = makeOnchainMintQuote();
    (quoteLifecycle.createMintQuote as any).mockImplementationOnce(async () => onchainQuote);

    await expect(api.mint.create({ mintUrl, method: 'onchain', unit: 'sat' })).resolves.toBe(
      onchainQuote,
    );

    expect(quoteLifecycle.createMintQuote).toHaveBeenCalledWith(mintUrl, 'onchain', {
      unit: 'sat',
    });
  });

  it('delegates BOLT12 mint quote creation with optional amount data', async () => {
    const bolt12Quote = makeBolt12MintQuote();
    (quoteLifecycle.createMintQuote as any).mockImplementationOnce(async () => bolt12Quote);

    await expect(
      api.mint.create({
        mintUrl,
        method: 'bolt12',
        unit: 'sat',
        amount: Amount.from(10),
        description: 'coffee',
      }),
    ).resolves.toBe(bolt12Quote);

    expect(quoteLifecycle.createMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt12', {
      unit: 'sat',
      amount: { amount: Amount.from(10), unit: 'sat' },
      description: 'coffee',
    });
  });

  it('delegates amountless BOLT12 mint quote creation without undefined amount', async () => {
    const bolt12Quote = makeBolt12MintQuote();
    (quoteLifecycle.createMintQuote as any).mockImplementationOnce(async () => bolt12Quote);

    await expect(
      api.mint.create({
        mintUrl,
        method: 'bolt12',
        unit: 'sat',
        description: 'coffee',
      }),
    ).resolves.toBe(bolt12Quote);

    expect(quoteLifecycle.createMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt12', {
      unit: 'sat',
      description: 'coffee',
    });
  });

  it('returns null for absent methodless quote lookups', async () => {
    (quoteLifecycle.getMintQuoteById as any).mockImplementationOnce(async () => null);
    (quoteLifecycle.getMeltQuoteById as any).mockImplementationOnce(async () => null);

    await expect(api.mint.get({ mintUrl, quoteId: 'missing-mint' })).resolves.toBeNull();
    await expect(api.melt.get({ mintUrl, quoteId: 'missing-melt' })).resolves.toBeNull();
  });

  it('delegates melt quote methods', async () => {
    await expect(
      api.melt.create({
        mintUrl,
        method: 'bolt11',
        methodData: { invoice: 'lnbc1melt' },
      }),
    ).resolves.toBe(meltQuote);
    await expect(api.melt.get({ mintUrl, quoteId })).resolves.toBe(meltQuote);
    await expect(api.melt.listPending({ method: 'bolt11' })).resolves.toEqual([meltQuote]);
    await expect(api.melt.refresh({ mintUrl, quoteId })).resolves.toMatchObject({
      state: 'PENDING',
    });

    expect(quoteLifecycle.createMeltQuote).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      { invoice: 'lnbc1melt' },
      undefined,
    );
    expect(quoteLifecycle.getMeltQuoteById).toHaveBeenCalledWith({ mintUrl, quoteId });
    expect(quoteLifecycle.getPendingMeltQuotes).toHaveBeenCalledWith('bolt11');
    expect(quoteLifecycle.refreshMeltQuoteById).toHaveBeenCalledWith({ mintUrl, quoteId });
  });

  it('types created BOLT melt quotes as direct prepare inputs', async () => {
    const meltOps = {
      prepare: mock(async () => undefined),
    } as unknown as Pick<MeltOpsApi, 'prepare'>;

    const quote = await api.melt.create({
      mintUrl,
      method: 'bolt11',
      methodData: { invoice: 'lnbc1melt' },
    });

    await meltOps.prepare({ quote });

    expect(meltOps.prepare).toHaveBeenCalledWith({ quote });
  });

  it('keeps method required for quote creation and import inputs', () => {
    assertMethodRequirementsRemain();
    void assertBuiltInAndGenericQuoteTypes;
  });

  it('rejects built-in method names on generic quote APIs before routing to lifecycle', async () => {
    await expect(
      api.mint.createGeneric({ mintUrl, method: 'bolt11', amount: Amount.from(10) } as any),
    ).rejects.toThrow('Built-in mint method bolt11 must use the built-in mint quote API');
    await expect(
      api.melt.createGeneric({ mintUrl, method: 'onchain', request: 'bc1q...' } as any),
    ).rejects.toThrow('Built-in melt method onchain must use the built-in melt quote API');

    expect(quoteLifecycle.createMintQuote).not.toHaveBeenCalled();
    expect(quoteLifecycle.createMeltQuote).not.toHaveBeenCalled();
  });
});
