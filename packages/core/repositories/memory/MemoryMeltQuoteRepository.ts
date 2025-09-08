import type { MeltQuote } from '@core/models/MeltQuote';
import type { MeltQuoteRepository } from '..';

export class MemoryMeltQuoteRepository implements MeltQuoteRepository {
  private readonly quotes = new Map<string, MeltQuote>();

  private makeKey(mintUrl: string, quoteId: string): string {
    return `${mintUrl}::${quoteId}`;
  }

  async getMeltQuote(mintUrl: string, quoteId: string): Promise<MeltQuote | null> {
    const key = this.makeKey(mintUrl, quoteId);
    return this.quotes.get(key) ?? null;
  }

  async addMeltQuote(quote: MeltQuote): Promise<void> {
    const key = this.makeKey(quote.mintUrl, quote.quote);
    this.quotes.set(key, quote);
  }

  async setMeltQuoteState(
    mintUrl: string,
    quoteId: string,
    state: MeltQuote['state'],
  ): Promise<void> {
    const key = this.makeKey(mintUrl, quoteId);
    const existing = this.quotes.get(key);
    if (!existing) return;
    this.quotes.set(key, { ...existing, state });
  }

  async getPendingMeltQuotes(): Promise<MeltQuote[]> {
    const result: MeltQuote[] = [];
    for (const q of this.quotes.values()) {
      if (q.state !== 'PAID') result.push(q);
    }
    return result;
  }
}
