import type { MeltMethod } from '../operations/melt/MeltMethodHandler';
import type { MeltQuote } from './MeltQuote';
import type { MintMethod } from '../operations/mint/MintMethodHandler';
import type { MintQuote } from './MintQuote';

export type QuoteIdentity = {
  mintUrl: string;
  quoteId: string;
};

export type MintQuoteRef<M extends MintMethod = MintMethod> = QuoteIdentity &
  Pick<MintQuote<M>, 'method'>;

export type MeltQuoteRef<M extends MeltMethod = MeltMethod> = QuoteIdentity &
  Pick<MeltQuote<M>, 'method'>;
