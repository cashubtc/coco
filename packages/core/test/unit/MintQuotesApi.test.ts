import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MintQuotesApi } from '../../api/MintQuotesApi.ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import type { MintOperationService } from '../../operations/mint/MintOperationService.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';

type Assert<T extends true> = T;
type CreateMintQuoteInput = Parameters<MintQuotesApi['create']>[0];
type _AssertBolt11CreateHasNoMethodData = Assert<
  Extract<CreateMintQuoteInput, { method: 'bolt11' }> extends {
    methodData: unknown;
  }
    ? false
    : true
>;

const makeQuote = (): MintQuote<'bolt11'> => ({
  mintUrl,
  method: 'bolt11',
  quoteId,
  quote: quoteId,
  request: 'lnbc1test',
  amount: Amount.from(10),
  unit: 'sat',
  expiry: Math.floor(Date.now() / 1000) + 3600,
  state: 'UNPAID',
  lastObservedRemoteState: 'UNPAID',
  lastObservedRemoteStateAt: Date.now(),
  reusable: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe('MintQuotesApi', () => {
  let api: MintQuotesApi;
  let mintOperationService: MintOperationService;
  let quote: MintQuote<'bolt11'>;

  beforeEach(() => {
    quote = makeQuote();
    mintOperationService = {
      createQuote: mock(async () => quote),
      getQuote: mock(async () => quote),
      getPendingQuotes: mock(async () => [quote]),
      refreshQuote: mock(async () => ({ ...quote, state: 'PAID' })),
    } as unknown as MintOperationService;

    api = new MintQuotesApi(mintOperationService);
  });

  it('create delegates quote-only creation to the service', async () => {
    const result = await api.create({
      mintUrl,
      amount: Amount.from(10),
      method: 'bolt11',
    });

    expect(mintOperationService.createQuote).toHaveBeenCalledWith(
      mintUrl,
      { amount: Amount.from(10), unit: 'sat' },
      'bolt11',
    );
    expect(result).toBe(quote);
  });

  it('get requires full quote identity', async () => {
    const result = await api.get({
      mintUrl,
      method: 'bolt11',
      quoteId,
    });

    expect(mintOperationService.getQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', quoteId);
    expect(result).toBe(quote);
  });

  it('listPending delegates optional method filtering', async () => {
    const result = await api.listPending({ method: 'bolt11' });

    expect(mintOperationService.getPendingQuotes).toHaveBeenCalledWith('bolt11');
    expect(result).toEqual([quote]);
  });

  it('refresh requires full quote identity', async () => {
    const result = await api.refresh({
      mintUrl,
      method: 'bolt11',
      quoteId,
    });

    expect(mintOperationService.refreshQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', quoteId);
    expect(result.state).toBe('PAID');
  });
});
