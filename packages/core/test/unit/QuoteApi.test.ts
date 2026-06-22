import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  QuoteApi,
  type CreateGenericMeltQuoteInput,
  type CreateGenericMintQuoteInput,
  type CreateMeltQuoteInput,
  type CreateMintQuoteInput,
  type GenericMeltQuoteCreateResult,
  type GenericMintQuoteCreateResult,
  type GenericQuoteApiShapes,
} from '../../api/QuoteApi.ts';
import type { MeltOpsApi } from '../../api/MeltOpsApi.ts';
import type { MeltQuote } from '../../models/MeltQuote.ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import type {
  GenericMeltMethod,
  ValidatedGenericMeltMethod,
} from '../../operations/melt/MeltMethodHandler.ts';
import type {
  GenericMintMethod,
  ValidatedGenericMintMethod,
} from '../../operations/mint/MintMethodHandler.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;

type MintCreateInput = Parameters<QuoteApi['mint']['create']>[0];
type MintImportInput = Parameters<QuoteApi['mint']['import']>[0];
type MeltCreateInput = Parameters<QuoteApi['melt']['create']>[0];
type _AssertBuiltInMintInputKeepsBolt11Narrowing = Assert<
  CreateMintQuoteInput<'bolt11'> extends {
    method: 'bolt11';
    amount: unknown;
  }
    ? true
    : false
>;
type _AssertBuiltInMeltInputKeepsBolt12Narrowing = Assert<
  CreateMeltQuoteInput<'bolt12'> extends {
    method: 'bolt12';
    methodData: { offer: string; invoice?: never };
  }
    ? true
    : false
>;
type _AssertArbitraryGenericMintIsNotNever = Assert<
  IsNever<GenericMintQuoteCreateResult<'nostr-zap'>> extends false ? true : false
>;
type _AssertArbitraryGenericMintIsNotAny = Assert<
  IsAny<GenericMintQuoteCreateResult<'nostr-zap'>> extends false ? true : false
>;
type _AssertArbitraryGenericMeltIsNotNever = Assert<
  IsNever<GenericMeltQuoteCreateResult<'lnurl-pay'>> extends false ? true : false
>;
type _AssertArbitraryGenericMeltIsNotAny = Assert<
  IsAny<GenericMeltQuoteCreateResult<'lnurl-pay'>> extends false ? true : false
>;
type _AssertBuiltInMintRejectedFromGenericShape = Assert<
  CreateGenericMintQuoteInput<'bolt11'>['method'] extends never ? true : false
>;
type _AssertBuiltInMeltRejectedFromGenericShape = Assert<
  CreateGenericMeltQuoteInput<'onchain'>['method'] extends never ? true : false
>;
type _AssertBroadMintStringRejectedAsGenericMethod = Assert<
  GenericMintMethod<string> extends never ? true : false
>;
type _AssertBroadMeltStringRejectedAsGenericMethod = Assert<
  GenericMeltMethod<string> extends never ? true : false
>;
type _AssertBroadMintInputRequiresValidatedMethod = Assert<
  CreateGenericMintQuoteInput<string>['method'] extends ValidatedGenericMintMethod ? true : false
>;
type _AssertBroadMeltInputRequiresValidatedMethod = Assert<
  CreateGenericMeltQuoteInput<string>['method'] extends ValidatedGenericMeltMethod ? true : false
>;

const genericMintInput: CreateGenericMintQuoteInput<'nostr-zap'> = {
  mintUrl,
  method: 'nostr-zap',
  amount: Amount.from(21),
  payload: { recipient: 'npub1test' },
};
const genericMeltInput: CreateGenericMeltQuoteInput<'lnurl-pay'> = {
  mintUrl,
  method: 'lnurl-pay',
  methodData: { request: 'lnurl1test', callback: 'https://example.test/pay' },
};
const validatedMintMethod = 'nostr-zap' as ValidatedGenericMintMethod;
const validatedMeltMethod = 'lnurl-pay' as ValidatedGenericMeltMethod;
const validatedGenericMintInput: CreateGenericMintQuoteInput<string> = {
  mintUrl,
  method: validatedMintMethod,
  amount: Amount.from(21),
};
const validatedGenericMeltInput: CreateGenericMeltQuoteInput<string> = {
  mintUrl,
  method: validatedMeltMethod,
  methodData: { request: 'lnurl1test', callback: 'https://example.test/pay' },
};
// @ts-expect-error Generic mint inputs require a concrete non-built-in method literal.
const untypedGenericMintInput: CreateGenericMintQuoteInput = {
  mintUrl,
  method: 'bolt11',
  amount: Amount.from(21),
};
// @ts-expect-error Generic melt inputs require a concrete non-built-in method literal.
const untypedGenericMeltInput: CreateGenericMeltQuoteInput = {
  mintUrl,
  method: 'onchain',
  methodData: { request: 'lnurl1test' },
};
const runtimeMintMethod: string = 'nostr-zap';
const runtimeMeltMethod: string = 'lnurl-pay';
const broadStringGenericMintInput: CreateGenericMintQuoteInput<string> = {
  mintUrl,
  // @ts-expect-error Broad runtime strings must be validated before generic mint quote use.
  method: runtimeMintMethod,
  amount: Amount.from(21),
};
const broadStringGenericMeltInput: CreateGenericMeltQuoteInput<string> = {
  mintUrl,
  // @ts-expect-error Broad runtime strings must be validated before generic melt quote use.
  method: runtimeMeltMethod,
  methodData: { request: 'lnurl1test' },
};

function assertGenericQuoteApiShapes(
  api: GenericQuoteApiShapes,
  rawMethod: string,
  validatedMint: ValidatedGenericMintMethod,
  validatedMelt: ValidatedGenericMeltMethod,
): void {
  void api.createMint({ mintUrl, method: 'nostr-zap', amount: Amount.from(21) });
  void api.createMelt({
    mintUrl,
    method: 'lnurl-pay',
    methodData: { request: 'lnurl1test' },
  });
  void api.createMint({ mintUrl, method: validatedMint, amount: Amount.from(21) });
  void api.createMelt({
    mintUrl,
    method: validatedMelt,
    methodData: { request: 'lnurl1test' },
  });
  // @ts-expect-error Broad runtime strings must be validated before generic quote use.
  void api.createMint({ mintUrl, method: rawMethod, amount: Amount.from(21) });
  // @ts-expect-error Built-in methods must use the built-in quote API.
  void api.createMint({ mintUrl, method: 'bolt11', amount: Amount.from(21) });
  // @ts-expect-error Built-in methods must use the built-in quote API.
  void api.createMelt({ mintUrl, method: 'onchain', methodData: { request: 'bc1test' } });
}

void [
  genericMintInput,
  genericMeltInput,
  validatedGenericMintInput,
  validatedGenericMeltInput,
  untypedGenericMintInput,
  untypedGenericMeltInput,
  broadStringGenericMintInput,
  broadStringGenericMeltInput,
  assertGenericQuoteApiShapes,
];

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
    await expect(api.mint.create({ mintUrl, method: 'onchain', unit: 'sat' })).resolves.toBe(
      mintQuote,
    );

    expect(quoteLifecycle.createMintQuote).toHaveBeenCalledWith(mintUrl, 'onchain', {
      unit: 'sat',
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
  });
});
