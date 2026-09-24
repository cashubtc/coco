import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { QuoteApi } from '../../api/QuoteApi.ts';
import type { MeltOpsApi } from '../../api/MeltOpsApi.ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';

type MintCreateInput = Parameters<QuoteApi['mint']['create']>[0];
type MintImportInput = Parameters<QuoteApi['mint']['import']>[0];
type MeltCreateInput = Parameters<QuoteApi['melt']['create']>[0];

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

// These assignments protect the public type contract during typecheck.
async function assertCreatedBoltMeltQuoteCanPrepare(
  api: QuoteApi,
  meltOps: Pick<MeltOpsApi, 'prepare'>,
): Promise<void> {
  const quote = await api.melt.create({
    mintUrl,
    method: 'bolt11',
    methodData: { invoice: 'lnbc1melt' },
  });
  await meltOps.prepare({ quote });
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
  reusable: false,
  amountPaid: Amount.zero(),
  amountIssued: Amount.zero(),
  remoteUpdatedAt: null,
  quoteData: {
    amount: Amount.from(10),
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe('QuoteApi', () => {
  let api: QuoteApi;
  let quoteLifecycle: QuoteLifecycle;
  let mintQuote: MintQuote<'bolt11'>;

  beforeEach(() => {
    mintQuote = makeMintQuote();
    quoteLifecycle = {
      createMintQuote: mock(async () => mintQuote),
    } as unknown as QuoteLifecycle;

    api = new QuoteApi(quoteLifecycle);
  });

  it('delegates opt-in locked BOLT11 quote creation', async () => {
    await expect(
      api.mint.create({
        mintUrl,
        method: 'bolt11',
        amount: Amount.from(10),
        locked: true,
      }),
    ).resolves.toBe(mintQuote);

    expect(quoteLifecycle.createMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', {
      amount: { amount: Amount.from(10), unit: 'sat' },
      locked: true,
    });
  });

  it('delegates BOLT12 mint quote creation with optional amount data', async () => {
    await expect(
      api.mint.create({
        mintUrl,
        method: 'bolt12',
        unit: 'sat',
        amount: Amount.from(10),
        description: 'coffee',
      }),
    ).resolves.toBe(mintQuote);

    expect(quoteLifecycle.createMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt12', {
      unit: 'sat',
      amount: { amount: Amount.from(10), unit: 'sat' },
      description: 'coffee',
    });
  });

  it('delegates amountless BOLT12 mint quote creation without undefined amount', async () => {
    await expect(
      api.mint.create({
        mintUrl,
        method: 'bolt12',
        unit: 'sat',
        description: 'coffee',
      }),
    ).resolves.toBe(mintQuote);

    expect(quoteLifecycle.createMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt12', {
      unit: 'sat',
      description: 'coffee',
    });
  });
});
