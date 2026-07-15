import { QuoteIdentityConflictError } from '@core/models/Error';
import type { MeltQuote } from '@core/models/MeltQuote';
import type { QuoteIdentity } from '@core/models/QuoteIdentity';
import type { MeltQuoteRepository } from '..';
import { normalizeMintUrl } from '../../utils';

export class MemoryMeltQuoteRepository implements MeltQuoteRepository {
  private readonly quotes = new Map<string, MeltQuote>();

  private makeKey(mintUrl: string, method: string, quoteId: string): string {
    return `${normalizeMintUrl(mintUrl)}::${method}::${quoteId}`;
  }

  async getMeltQuoteById(identity: QuoteIdentity): Promise<MeltQuote | null> {
    const normalizedMintUrl = normalizeMintUrl(identity.mintUrl);
    const matches = Array.from(this.quotes.values()).filter(
      (quote) => quote.mintUrl === normalizedMintUrl && quote.quoteId === identity.quoteId,
    );
    if (matches.length > 1) {
      throw new QuoteIdentityConflictError(
        'melt',
        normalizedMintUrl,
        identity.quoteId,
        matches.map((quote) => quote.method),
      );
    }
    return matches[0] ? { ...matches[0] } : null;
  }

  async getMeltQuote(mintUrl: string, method: string, quoteId: string): Promise<MeltQuote | null> {
    const quote = this.quotes.get(this.makeKey(mintUrl, method, quoteId));
    return quote ? { ...quote } : null;
  }

  async upsertMeltQuote(quote: MeltQuote): Promise<MeltQuote> {
    const normalizedMintUrl = normalizeMintUrl(quote.mintUrl);
    const now = Date.now();
    const identityOwner = await this.getMeltQuoteById({
      mintUrl: normalizedMintUrl,
      quoteId: quote.quoteId,
    });
    if (identityOwner && identityOwner.method !== quote.method) {
      throw new QuoteIdentityConflictError(
        'melt',
        normalizedMintUrl,
        quote.quoteId,
        [identityOwner.method, quote.method],
        `Melt quote ${quote.quoteId} at ${normalizedMintUrl} already exists for method ${identityOwner.method}`,
      );
    }
    const existing = await this.getMeltQuote(normalizedMintUrl, quote.method, quote.quoteId);
    const persisted = {
      ...quote,
      mintUrl: normalizedMintUrl,
      quote: quote.quoteId,
      createdAt: existing?.createdAt ?? quote.createdAt,
      updatedAt: now,
    };
    this.quotes.set(this.makeKey(normalizedMintUrl, quote.method, quote.quoteId), persisted);
    return { ...persisted };
  }

  async getPendingMeltQuotes(method?: string): Promise<MeltQuote[]> {
    const result: MeltQuote[] = [];
    for (const quote of this.quotes.values()) {
      if (method && quote.method !== method) continue;
      if (quote.state !== 'PAID') result.push({ ...quote });
    }
    return result;
  }
}
