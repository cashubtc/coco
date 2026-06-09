import type { MeltMethodInputData } from '@core/operations/melt';
import type { MintMethodQuoteSnapshot } from '@core/operations/mint';
import { DEFAULT_UNIT, normalizeUnit, parseUnitAmount, type UnitAmountLike } from '../amounts.ts';
import type { MeltQuote } from '../models/MeltQuote';
import type { MintQuote } from '../models/MintQuote';
import type { QuoteLifecycle } from '../quotes/QuoteLifecycle';
import type { DefaultSupportedMeltMethod } from './MeltOpsApi.ts';

export type DefaultSupportedMintQuoteMethod = 'bolt11' | 'onchain' | 'bolt12';

export type CreateMintQuoteInput =
  | {
      mintUrl: string;
      method: 'bolt11';
      amount: UnitAmountLike;
      unit?: string;
    }
  | {
      mintUrl: string;
      method: 'onchain';
      unit?: string;
    }
  | {
      mintUrl: string;
      method: 'bolt12';
      unit?: string;
      amount?: UnitAmountLike;
      description?: string;
    };

export type GetMintQuoteInput = {
  mintUrl: string;
  method: DefaultSupportedMintQuoteMethod;
  quoteId: string;
};

export type ImportMintQuoteInput = {
  /** Mint that issued the existing quote. */
  mintUrl: string;
  /** Existing quote snapshot to persist as canonical quote state. */
  quote: MintMethodQuoteSnapshot<'bolt11'>;
  /** Mint method for the quote snapshot. */
  method: 'bolt11';
};

export type RefreshMintQuoteInput = GetMintQuoteInput;

export type ListPendingMintQuotesInput = {
  method?: DefaultSupportedMintQuoteMethod;
};

export type CreateMeltQuoteInput = {
  [M in DefaultSupportedMeltMethod]: {
    mintUrl: string;
    method: M;
    methodData: MeltMethodInputData<M>;
    unit?: string;
  };
}[DefaultSupportedMeltMethod];

export type GetMeltQuoteInput = {
  mintUrl: string;
  method: DefaultSupportedMeltMethod;
  quoteId: string;
};

export type RefreshMeltQuoteInput = GetMeltQuoteInput;

export type ListPendingMeltQuotesInput = {
  method?: DefaultSupportedMeltMethod;
};

export class MintQuoteApi {
  constructor(private readonly quoteLifecycle: QuoteLifecycle) {}

  async create(input: CreateMintQuoteInput): Promise<MintQuote> {
    if (input.method === 'bolt11') {
      const parsed = parseUnitAmount(input.amount, { explicitUnit: input.unit });
      return this.quoteLifecycle.createMintQuote(input.mintUrl, input.method, {
        amount: parsed,
      });
    }

    if (input.method === 'bolt12') {
      const parsed =
        input.amount !== undefined
          ? parseUnitAmount(input.amount, { explicitUnit: input.unit })
          : undefined;
      const unit = parsed?.unit ?? normalizeUnit(input.unit, { defaultUnit: DEFAULT_UNIT });
      const createQuoteData =
        parsed === undefined
          ? { unit, description: input.description }
          : { unit, amount: parsed, description: input.description };
      return this.quoteLifecycle.createMintQuote(input.mintUrl, input.method, createQuoteData);
    }

    return this.quoteLifecycle.createMintQuote(input.mintUrl, input.method, {
      unit: normalizeUnit(input.unit, { defaultUnit: DEFAULT_UNIT }),
    });
  }

  get(input: GetMintQuoteInput): Promise<MintQuote | null> {
    return this.quoteLifecycle.getMintQuote(input.mintUrl, input.method, input.quoteId);
  }

  import(input: ImportMintQuoteInput): Promise<MintQuote> {
    return this.quoteLifecycle.importMintQuote(input.mintUrl, input.method, input.quote);
  }

  listPending(input: ListPendingMintQuotesInput = {}): Promise<MintQuote[]> {
    return this.quoteLifecycle.getPendingMintQuotes(input.method);
  }

  refresh(input: RefreshMintQuoteInput): Promise<MintQuote> {
    return this.quoteLifecycle.refreshMintQuote(input.mintUrl, input.method, input.quoteId);
  }
}

export class MeltQuoteApi {
  constructor(private readonly quoteLifecycle: QuoteLifecycle) {}

  create(input: CreateMeltQuoteInput): Promise<MeltQuote> {
    return this.quoteLifecycle.createMeltQuote(
      input.mintUrl,
      input.method,
      input.methodData,
      input.unit,
    );
  }

  get(input: GetMeltQuoteInput): Promise<MeltQuote | null> {
    return this.quoteLifecycle.getMeltQuote(input.mintUrl, input.method, input.quoteId);
  }

  listPending(input: ListPendingMeltQuotesInput = {}): Promise<MeltQuote[]> {
    return this.quoteLifecycle.getPendingMeltQuotes(input.method);
  }

  refresh(input: RefreshMeltQuoteInput): Promise<MeltQuote> {
    return this.quoteLifecycle.refreshMeltQuote(input.mintUrl, input.method, input.quoteId);
  }
}

/**
 * API for durable canonical quote state.
 *
 * Quote rows are not value movements and are separate from operation history.
 */
export class QuoteApi {
  readonly mint: MintQuoteApi;
  readonly melt: MeltQuoteApi;

  constructor(quoteLifecycle: QuoteLifecycle) {
    this.mint = new MintQuoteApi(quoteLifecycle);
    this.melt = new MeltQuoteApi(quoteLifecycle);
  }
}
