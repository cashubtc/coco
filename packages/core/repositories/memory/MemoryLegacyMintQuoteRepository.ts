import { isMintQuotePending, type MintQuote } from '@core/models/MintQuote';
import type { LegacyMintQuoteRepository } from '..';
import { normalizeMintUrl } from '../../utils';
import { cloneMemoryValue, COPY_MEMORY_REPOSITORY_STATE } from './MemoryRepositoryTransaction.ts';

export class MemoryLegacyMintQuoteRepository implements LegacyMintQuoteRepository {
  private quotes = new Map<string, MintQuote>();

  [COPY_MEMORY_REPOSITORY_STATE](source: MemoryLegacyMintQuoteRepository): void {
    this.quotes = cloneMemoryValue(source.quotes);
  }

  private makeKey(mintUrl: string, method: string, quoteId: string): string {
    return `${normalizeMintUrl(mintUrl)}::${method}::${quoteId}`;
  }

  async upsertMintQuote(quote: MintQuote): Promise<void> {
    const normalizedMintUrl = normalizeMintUrl(quote.mintUrl);
    const key = this.makeKey(normalizedMintUrl, quote.method, quote.quoteId);
    this.quotes.set(key, {
      ...quote,
      mintUrl: normalizedMintUrl,
      quote: quote.quoteId,
    });
  }

  async getPendingLegacyMintQuotes(mintUrl?: string): Promise<MintQuote[]> {
    const normalizedMintUrl = mintUrl ? normalizeMintUrl(mintUrl) : undefined;
    const result: MintQuote[] = [];
    for (const quote of this.quotes.values()) {
      if (normalizedMintUrl && quote.mintUrl !== normalizedMintUrl) continue;
      if (isMintQuotePending(quote)) result.push({ ...quote });
    }
    return result;
  }
}
