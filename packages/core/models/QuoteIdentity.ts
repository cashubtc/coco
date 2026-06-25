import type { MeltMethod } from '../operations/melt/MeltMethodHandler';
import type { MeltQuote } from './MeltQuote';
import type { MintMethod } from '../operations/mint/MintMethodHandler';
import type { MintQuote } from './MintQuote';

/**
 * Public quote identity shared by mint and melt quote APIs.
 *
 * The identity intentionally omits `method`: callers identify a quote by `{ mintUrl, quoteId }`,
 * and repositories compare the identity after normalizing `mintUrl`. Within each quote kind
 * (mint quotes separately from melt quotes), a quote ID must be unique for a normalized mint URL
 * across all methods. Mint quote identities and melt quote identities are separate namespaces, so
 * the same `{ mintUrl, quoteId }` can identify one mint quote and one melt quote.
 */
export type QuoteIdentity = {
  mintUrl: string;
  quoteId: string;
};

/**
 * Method-scoped mint quote reference used after the quote method is known. The `method` narrows the
 * public `QuoteIdentity` to the concrete repository row; it is not part of public quote identity.
 */
export type MintQuoteRef<M extends MintMethod = MintMethod> = QuoteIdentity &
  Pick<MintQuote<M>, 'method'>;

/**
 * Method-scoped melt quote reference used after the quote method is known. The `method` narrows the
 * public `QuoteIdentity` to the concrete repository row; it is not part of public quote identity.
 */
export type MeltQuoteRef<M extends MeltMethod = MeltMethod> = QuoteIdentity &
  Pick<MeltQuote<M>, 'method'>;
