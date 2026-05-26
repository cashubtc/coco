import { Amount } from '@cashu/cashu-ts';
import type { MeltMethod, MeltMethodInputData } from '@core/operations/melt';
import type { MintMethod, MintMethodData } from '@core/operations/mint';
import { DEFAULT_UNIT, normalizeUnit, parseUnitAmount, type UnitAmountLike } from '../amounts.ts';
import type { MeltQuote } from '../models/MeltQuote';
import type { MintQuote } from '../models/MintQuote';
import type { QuoteLifecycle } from '../quotes/QuoteLifecycle';
import type { DefaultSupportedMeltMethod } from './MeltOpsApi.ts';
import type { DefaultSupportedMintMethod } from './MintOpsApi.ts';

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

type MintQuoteMethodDataInput<M extends MintMethod> = {
  /** Method-specific quote payload for the selected mint method. */
  methodData?: MintMethodData<M>;
};

type CreateMintQuoteAmountInput<M extends MintMethod> = M extends 'bolt12'
  ? {
      /**
       * Requested quote amount. Omit for BOLT12 amountless offers; the operation
       * amount is supplied later when preparing against the reusable quote.
       */
      amount?: UnitAmountLike;
    }
  : {
      /** Requested quote amount. */
      amount: UnitAmountLike;
    };

export type CreateMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintMethod> = {
  [M in TSupported]: {
    mintUrl: string;
    unit?: string;
    method: M;
  } & CreateMintQuoteAmountInput<M> &
    MintQuoteMethodDataInput<M>;
}[TSupported];

export type GetMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintMethod> = {
  [M in TSupported]: MintQuoteIdentityInput<M>;
}[TSupported];

export type RefreshMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintMethod> =
  GetMintQuoteInput<TSupported>;

export type ListPendingMintQuotesInput<TSupported extends MintMethod = DefaultSupportedMintMethod> =
  {
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

export class MintQuoteApi<TSupported extends MintMethod = DefaultSupportedMintMethod> {
  constructor(private readonly quoteLifecycle: QuoteLifecycle) {}

  async create(input: CreateMintQuoteInput<TSupported>): Promise<MintQuote> {
    const methodData = ('methodData' in input ? input.methodData : undefined) ?? {};
    const parsed =
      'amount' in input && input.amount !== undefined
        ? parseUnitAmount(input.amount, { explicitUnit: input.unit })
        : {
            amount: Amount.zero(),
            unit: normalizeUnit(input.unit, { defaultUnit: DEFAULT_UNIT }),
          };

    return this.quoteLifecycle.createMintQuote(input.mintUrl, parsed, input.method, methodData);
  }

  get(input: GetMintQuoteInput<TSupported>): Promise<MintQuote | null> {
    return this.quoteLifecycle.getMintQuote(input.mintUrl, input.method, input.quoteId);
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
  TMintSupported extends MintMethod = DefaultSupportedMintMethod,
  TMeltSupported extends MeltMethod = DefaultSupportedMeltMethod,
> {
  readonly mint: MintQuoteApi<TMintSupported>;
  readonly melt: MeltQuoteApi<TMeltSupported>;

  constructor(quoteLifecycle: QuoteLifecycle) {
    this.mint = new MintQuoteApi(quoteLifecycle);
    this.melt = new MeltQuoteApi(quoteLifecycle);
  }
}
