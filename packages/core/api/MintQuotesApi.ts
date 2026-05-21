import type { MintMethod, MintOperationService } from '@core/operations/mint';
import { parseUnitAmount, type UnitAmountLike } from '../amounts.ts';
import type { MintQuote } from '../models/MintQuote';
import type { DefaultSupportedMintMethod } from './MintOpsApi.ts';

type MethodInput<M extends MintMethod> = {
  /** Mint method for this quote, for example `bolt11`. */
  method: M;
};

type QuoteIdentityInput<M extends MintMethod> = MethodInput<M> & {
  /** Mint that issued the canonical quote. */
  mintUrl: string;
  /** Existing canonical mint quote ID. */
  quoteId: string;
};

export type CreateMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintMethod> = {
  [M in TSupported]: MethodInput<M> & {
    /** Mint that will issue the quote. */
    mintUrl: string;
    /** Amount to request from the mint. Bare amounts use `sat` unless `unit` is set. */
    amount: UnitAmountLike;
    /** Unit to request from the mint. */
    unit?: string;
  };
}[TSupported];

export type GetMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintMethod> = {
  [M in TSupported]: QuoteIdentityInput<M>;
}[TSupported];

export type RefreshMintQuoteInput<TSupported extends MintMethod = DefaultSupportedMintMethod> =
  GetMintQuoteInput<TSupported>;

export type ListPendingMintQuotesInput<
  TSupported extends MintMethod = DefaultSupportedMintMethod,
> = {
  /** Optional mint method filter. */
  method?: TSupported;
};

/**
 * API for durable canonical mint quote state.
 *
 * Quote rows are not value movements and are separate from mint operation history.
 */
export class MintQuotesApi<TSupported extends MintMethod = DefaultSupportedMintMethod> {
  constructor(private readonly mintOperationService: MintOperationService) {}

  /**
   * Creates and persists a canonical remote quote without creating a mint operation.
   */
  async create(input: CreateMintQuoteInput<TSupported>): Promise<MintQuote> {
    const parsed = parseUnitAmount(input.amount, { explicitUnit: input.unit });
    return this.mintOperationService.createQuote(input.mintUrl, parsed, input.method);
  }

  /** Returns a canonical mint quote by full identity, or `null` when it does not exist. */
  async get(input: GetMintQuoteInput<TSupported>): Promise<MintQuote | null> {
    return this.mintOperationService.getQuote(input.mintUrl, input.method, input.quoteId);
  }

  /** Lists canonical mint quote rows that have not reached `ISSUED`. */
  async listPending(input: ListPendingMintQuotesInput<TSupported> = {}): Promise<MintQuote[]> {
    return this.mintOperationService.getPendingQuotes(input.method);
  }

  /**
   * Checks the remote quote state, persists the canonical quote row, then emits an update event.
   */
  async refresh(input: RefreshMintQuoteInput<TSupported>): Promise<MintQuote> {
    return this.mintOperationService.refreshQuote(input.mintUrl, input.method, input.quoteId);
  }
}
