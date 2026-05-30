import type { MeltMethod, MeltMethodInputData } from '@core/operations/melt';
import type {
  MintMethod,
  MintMethodCreateQuoteData,
  MintMethodQuoteSnapshot,
} from '@core/operations/mint';
import { DEFAULT_UNIT, normalizeUnit, parseUnitAmount, type UnitAmountLike } from '../amounts.ts';
import type { MeltQuote } from '../models/MeltQuote';
import type { MintQuote } from '../models/MintQuote';
import type { QuoteLifecycle } from '../quotes/QuoteLifecycle';
import type { DefaultSupportedMeltMethod } from './MeltOpsApi.ts';

export type DefaultSupportedMintQuoteMethod = 'bolt11' | 'onchain';

type MintQuoteIdentityInput<M extends MintMethod> = {
  mintUrl: string;
  method: M;
  quoteId: string;
};

type MeltQuoteIdentityInput<M extends MeltMethod> = {
  mintUrl: string;
  method: M;
  quoteId: string;
};

export type CreateMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintQuoteMethod> =
  {
    [M in TSupported]: { mintUrl: string; method: M } & (M extends 'bolt11'
      ? {
          amount: UnitAmountLike;
          unit?: string;
        }
      : M extends 'onchain'
        ? {
            unit?: string;
          }
        : never);
  }[TSupported];

export type GetMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintQuoteMethod> = {
  [M in TSupported]: MintQuoteIdentityInput<M>;
}[TSupported];

export type ImportMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintQuoteMethod> =
  {
    [M in TSupported]: {
      /** Mint that issued the existing quote. */
      mintUrl: string;
      /** Existing quote snapshot to persist as canonical quote state. */
      quote: MintMethodQuoteSnapshot<M>;
      /** Mint method for the quote snapshot. */
      method: M;
    };
  }[TSupported];

export type RefreshMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintQuoteMethod> =
  GetMintQuoteInput<TSupported>;

export type ListPendingMintQuotesInput<
  TSupported extends MintMethod = DefaultSupportedMintQuoteMethod,
> = {
  method?: TSupported;
};

export type CreateMeltQuoteInput<TSupported extends MeltMethod = DefaultSupportedMeltMethod> = {
  [M in TSupported]: {
    mintUrl: string;
    method: M;
    methodData: MeltMethodInputData<M>;
    unit?: string;
  };
}[TSupported];

export type GetMeltQuoteInput<TSupported extends MeltMethod = DefaultSupportedMeltMethod> = {
  [M in TSupported]: MeltQuoteIdentityInput<M>;
}[TSupported];

export type RefreshMeltQuoteInput<TSupported extends MeltMethod = DefaultSupportedMeltMethod> =
  GetMeltQuoteInput<TSupported>;

export type ListPendingMeltQuotesInput<TSupported extends MeltMethod = DefaultSupportedMeltMethod> =
  {
    method?: TSupported;
  };

export class MintQuoteApi<TSupported extends MintMethod = DefaultSupportedMintQuoteMethod> {
  constructor(private readonly quoteLifecycle: QuoteLifecycle) {}

  async create(input: CreateMintQuoteInput<TSupported>): Promise<MintQuote> {
    if ('amount' in input) {
      const parsed = parseUnitAmount(input.amount, { explicitUnit: input.unit });
      return this.quoteLifecycle.createMintQuote(input.mintUrl, input.method, {
        amount: parsed,
      } as MintMethodCreateQuoteData<typeof input.method>);
    }

    return this.quoteLifecycle.createMintQuote(input.mintUrl, input.method, {
      unit: normalizeUnit(input.unit, { defaultUnit: DEFAULT_UNIT }),
    } as MintMethodCreateQuoteData<typeof input.method>);
  }

  get(input: GetMintQuoteInput<TSupported>): Promise<MintQuote | null> {
    return this.quoteLifecycle.getMintQuote(input.mintUrl, input.method, input.quoteId);
  }

  import(input: ImportMintQuoteInput<TSupported>): Promise<MintQuote> {
    return this.quoteLifecycle.importMintQuote(input.mintUrl, input.method, input.quote);
  }

  listPending(input: ListPendingMintQuotesInput<TSupported> = {}): Promise<MintQuote[]> {
    return this.quoteLifecycle.getPendingMintQuotes(input.method);
  }

  refresh(input: RefreshMintQuoteInput<TSupported>): Promise<MintQuote> {
    return this.quoteLifecycle.refreshMintQuote(input.mintUrl, input.method, input.quoteId);
  }
}

export class MeltQuoteApi<TSupported extends MeltMethod = DefaultSupportedMeltMethod> {
  constructor(private readonly quoteLifecycle: QuoteLifecycle) {}

  create(input: CreateMeltQuoteInput<TSupported>): Promise<MeltQuote> {
    return this.quoteLifecycle.createMeltQuote(
      input.mintUrl,
      input.method,
      input.methodData,
      input.unit,
    );
  }

  get(input: GetMeltQuoteInput<TSupported>): Promise<MeltQuote | null> {
    return this.quoteLifecycle.getMeltQuote(input.mintUrl, input.method, input.quoteId);
  }

  listPending(input: ListPendingMeltQuotesInput<TSupported> = {}): Promise<MeltQuote[]> {
    return this.quoteLifecycle.getPendingMeltQuotes(input.method);
  }

  refresh(input: RefreshMeltQuoteInput<TSupported>): Promise<MeltQuote> {
    return this.quoteLifecycle.refreshMeltQuote(input.mintUrl, input.method, input.quoteId);
  }
}

/**
 * API for durable canonical quote state.
 *
 * Quote rows are not value movements and are separate from operation history.
 */
export class QuoteApi<
  TMintSupported extends MintMethod = DefaultSupportedMintQuoteMethod,
  TMeltSupported extends MeltMethod = DefaultSupportedMeltMethod,
> {
  readonly mint: MintQuoteApi<TMintSupported>;
  readonly melt: MeltQuoteApi<TMeltSupported>;

  constructor(quoteLifecycle: QuoteLifecycle) {
    this.mint = new MintQuoteApi(quoteLifecycle);
    this.melt = new MeltQuoteApi(quoteLifecycle);
  }
}
