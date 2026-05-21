import type { MeltQuote } from '@core/models/MeltQuote';
import type { MeltQuoteRepository } from '..';
import { normalizeMintUrl } from '../../utils';

export class MemoryMeltQuoteRepository implements MeltQuoteRepository {
  private readonly quotes = new Map<string, MeltQuote>();

  private makeKey(mintUrl: string, method: string, quoteId: string): string {
    return `${normalizeMintUrl(mintUrl)}::${method}::${quoteId}`;
  }

  async getMeltQuote(mintUrl: string, method: string, quoteId: string): Promise<MeltQuote | null> {
    const quote = this.quotes.get(this.makeKey(mintUrl, method, quoteId));
    return quote ? { ...quote } : null;
  }

  async upsertMeltQuote(quote: MeltQuote): Promise<void> {
    const normalizedMintUrl = normalizeMintUrl(quote.mintUrl);
    const now = Date.now();
    const existing = await this.getMeltQuote(normalizedMintUrl, quote.method, quote.quoteId);
    this.quotes.set(this.makeKey(normalizedMintUrl, quote.method, quote.quoteId), {
      ...quote,
      mintUrl: normalizedMintUrl,
      quote: quote.quoteId,
      createdAt: existing?.createdAt ?? quote.createdAt,
      updatedAt: now,
    });
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
