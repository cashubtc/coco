import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { QuoteApi } from '../../api/QuoteApi.ts';
import type { MeltQuote } from '../../models/MeltQuote.ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';

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
      getMintQuote: mock(async () => mintQuote),
      getPendingMintQuotes: mock(async () => [mintQuote]),
      refreshMintQuote: mock(async () => ({ ...mintQuote, state: 'PAID' })),
      createMeltQuote: mock(async () => meltQuote),
      getMeltQuote: mock(async () => meltQuote),
      getPendingMeltQuotes: mock(async () => [meltQuote]),
      refreshMeltQuote: mock(async () => ({ ...meltQuote, state: 'PENDING' })),
    } as unknown as QuoteLifecycle;

    api = new QuoteApi(quoteLifecycle);
  });

  it('delegates mint quote methods', async () => {
    await expect(
      api.mint.create({ mintUrl, amount: Amount.from(10), method: 'bolt11' }),
    ).resolves.toBe(mintQuote);
    await expect(api.mint.get({ mintUrl, method: 'bolt11', quoteId })).resolves.toBe(mintQuote);
    await expect(api.mint.listPending({ method: 'bolt11' })).resolves.toEqual([mintQuote]);
    await expect(api.mint.refresh({ mintUrl, method: 'bolt11', quoteId })).resolves.toMatchObject({
      state: 'PAID',
    });

    expect(quoteLifecycle.createMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', {
      amount: { amount: Amount.from(10), unit: 'sat' },
    });
    expect(quoteLifecycle.getMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', quoteId);
    expect(quoteLifecycle.getPendingMintQuotes).toHaveBeenCalledWith('bolt11');
    expect(quoteLifecycle.refreshMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', quoteId);
  });

  it('delegates onchain mint quote creation without an amount', async () => {
    await expect(api.mint.create({ mintUrl, method: 'onchain', unit: 'sat' })).resolves.toBe(
      mintQuote,
    );

    expect(quoteLifecycle.createMintQuote).toHaveBeenCalledWith(mintUrl, 'onchain', {
      unit: 'sat',
    });
  });

  it('delegates melt quote methods', async () => {
    await expect(
      api.melt.create({
        mintUrl,
        method: 'bolt11',
        methodData: { invoice: 'lnbc1melt' },
      }),
    ).resolves.toBe(meltQuote);
    await expect(api.melt.get({ mintUrl, method: 'bolt11', quoteId })).resolves.toBe(meltQuote);
    await expect(api.melt.listPending({ method: 'bolt11' })).resolves.toEqual([meltQuote]);
    await expect(api.melt.refresh({ mintUrl, method: 'bolt11', quoteId })).resolves.toMatchObject({
      state: 'PENDING',
    });

    expect(quoteLifecycle.createMeltQuote).toHaveBeenCalledWith(
      mintUrl,
      'bolt11',
      { invoice: 'lnbc1melt' },
      undefined,
    );
    expect(quoteLifecycle.getMeltQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', quoteId);
    expect(quoteLifecycle.getPendingMeltQuotes).toHaveBeenCalledWith('bolt11');
    expect(quoteLifecycle.refreshMeltQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', quoteId);
  });
});
