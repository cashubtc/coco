import type { MeltMethod, MeltMethodInputData, MeltOperationService } from '@core/operations/melt';
import type { MintMethod, MintOperationService } from '@core/operations/mint';
import { parseUnitAmount, type UnitAmountLike } from '../amounts.ts';
import type { MeltQuote } from '../models/MeltQuote';
import type { MintQuote } from '../models/MintQuote';
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

export type CreateMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintMethod> = {
  [M in TSupported]: {
    mintUrl: string;
    amount: UnitAmountLike;
    unit?: string;
    method: M;
  };
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

export interface MintQuoteApi<TSupported extends MintMethod = DefaultSupportedMintMethod> {
  create(input: CreateMintQuoteInput<TSupported>): Promise<MintQuote>;
  get(input: GetMintQuoteInput<TSupported>): Promise<MintQuote | null>;
  listPending(input?: ListPendingMintQuotesInput<TSupported>): Promise<MintQuote[]>;
  refresh(input: RefreshMintQuoteInput<TSupported>): Promise<MintQuote>;
}

export interface MeltQuoteApi<TSupported extends MeltMethod = DefaultSupportedMeltMethod> {
  create(input: CreateMeltQuoteInput<TSupported>): Promise<MeltQuote>;
  get(input: GetMeltQuoteInput<TSupported>): Promise<MeltQuote | null>;
  listPending(input?: ListPendingMeltQuotesInput<TSupported>): Promise<MeltQuote[]>;
  refresh(input: RefreshMeltQuoteInput<TSupported>): Promise<MeltQuote>;
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

  constructor(
    private readonly mintOperationService: MintOperationService,
    private readonly meltOperationService: MeltOperationService,
  ) {
    this.mint = {
      create: async (input) => {
        const parsed = parseUnitAmount(input.amount, { explicitUnit: input.unit });
        return this.mintOperationService.createQuote(input.mintUrl, parsed, input.method);
      },
      get: (input) =>
        this.mintOperationService.getQuote(input.mintUrl, input.method, input.quoteId),
      listPending: (input = {}) => this.mintOperationService.getPendingQuotes(input.method),
      refresh: (input) =>
        this.mintOperationService.refreshQuote(input.mintUrl, input.method, input.quoteId),
    };

    this.melt = {
      create: (input) =>
        this.meltOperationService.createQuote(
          input.mintUrl,
          input.method,
          input.methodData,
          input.unit,
        ),
      get: (input) =>
        this.meltOperationService.getQuote(input.mintUrl, input.method, input.quoteId),
      listPending: (input = {}) => this.meltOperationService.getPendingQuotes(input.method),
      refresh: (input) =>
        this.meltOperationService.refreshQuote(input.mintUrl, input.method, input.quoteId),
    };
  }
}
