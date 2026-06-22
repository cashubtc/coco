import type {
  BuiltInMeltMethod,
  GenericMeltMethod,
  MeltMethodInputData,
} from '@core/operations/melt';
import type {
  BuiltInMintMethod,
  GenericMintMethod,
  GenericMintQuoteCreatePayload,
  MintMethodQuoteSnapshot,
} from '@core/operations/mint';
import { DEFAULT_UNIT, normalizeUnit, parseUnitAmount, type UnitAmountLike } from '../amounts.ts';
import type { GenericMeltQuote, MeltQuote } from '../models/MeltQuote';
import type { GenericMintQuote, MintQuote } from '../models/MintQuote';
import type { QuoteIdentity } from '../models/QuoteIdentity';
import type { QuoteLifecycle } from '../quotes/QuoteLifecycle';

export type CreateMintQuoteInput<M extends BuiltInMintMethod = BuiltInMintMethod> = Extract<
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
    },
  { method: M }
>;

export type CreateGenericMintQuoteInput<M extends string = string> = {
  mintUrl: string;
  method: GenericMintMethod<M>;
  amount: UnitAmountLike;
  unit?: string;
  payload?: GenericMintQuoteCreatePayload;
};

export type CreateGenericMeltQuoteInput<M extends string = string> = {
  mintUrl: string;
  method: GenericMeltMethod<M>;
  methodData: MeltMethodInputData<GenericMeltMethod<M>>;
  unit?: string;
};

export type GenericMintQuoteCreateResult<M extends string> =
  GenericMintMethod<M> extends never ? never : GenericMintQuote<GenericMintMethod<M>>;

export type GenericMeltQuoteCreateResult<M extends string> =
  GenericMeltMethod<M> extends never ? never : GenericMeltQuote<GenericMeltMethod<M>>;

export interface GenericQuoteApiShapes {
  createMint<M extends string>(
    input: CreateGenericMintQuoteInput<M>,
  ): Promise<GenericMintQuoteCreateResult<M>>;
  createMelt<M extends string>(
    input: CreateGenericMeltQuoteInput<M>,
  ): Promise<GenericMeltQuoteCreateResult<M>>;
}

export type ImportMintQuoteInput = {
  /** Mint that issued the existing quote. */
  mintUrl: string;
  /** Existing quote snapshot to persist as canonical quote state. */
  quote: MintMethodQuoteSnapshot<'bolt11'>;
  /** Mint method for the quote snapshot. */
  method: 'bolt11';
};

export type ListPendingMintQuotesInput = {
  method?: BuiltInMintMethod;
};

export type CreateMeltQuoteInput<TSupported extends BuiltInMeltMethod = BuiltInMeltMethod> = {
  [M in TSupported]: {
    mintUrl: string;
    method: M;
    methodData: MeltMethodInputData<M>;
    unit?: string;
  };
}[TSupported];

export type ListPendingMeltQuotesInput = {
  method?: BuiltInMeltMethod;
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

  get(input: QuoteIdentity): Promise<MintQuote | null> {
    return this.quoteLifecycle.getMintQuoteById(input);
  }

  import(input: ImportMintQuoteInput): Promise<MintQuote> {
    return this.quoteLifecycle.importMintQuote(input.mintUrl, input.method, input.quote);
  }

  listPending(input: ListPendingMintQuotesInput = {}): Promise<MintQuote[]> {
    return this.quoteLifecycle.getPendingMintQuotes(input.method);
  }

  refresh(input: QuoteIdentity): Promise<MintQuote> {
    return this.quoteLifecycle.refreshMintQuoteById(input);
  }
}

export class MeltQuoteApi {
  constructor(private readonly quoteLifecycle: QuoteLifecycle) {}

  create<M extends BuiltInMeltMethod>(input: CreateMeltQuoteInput<M>): Promise<MeltQuote<M>> {
    return this.quoteLifecycle.createMeltQuote(
      input.mintUrl,
      input.method,
      input.methodData,
      input.unit,
    );
  }

  get(input: QuoteIdentity): Promise<MeltQuote | null> {
    return this.quoteLifecycle.getMeltQuoteById(input);
  }

  listPending(input: ListPendingMeltQuotesInput = {}): Promise<MeltQuote[]> {
    return this.quoteLifecycle.getPendingMeltQuotes(input.method);
  }

  refresh(input: QuoteIdentity): Promise<MeltQuote> {
    return this.quoteLifecycle.refreshMeltQuoteById(input);
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
