import { QuoteIdentityConflictError } from '@core/models/Error';
import {
  deriveMintQuoteAccountingFromState,
  isMintQuotePending,
  isStatefulMintQuote,
  type MintQuote,
} from '@core/models/MintQuote';
import type { QuoteIdentity } from '@core/models/QuoteIdentity';
import type { MintMethodRemoteState } from '@core/operations/mint/MintMethodHandler';
import type { MintQuoteRepository } from '..';
import { normalizeMintUrl } from '../../utils';

export class MemoryMintQuoteRepository implements MintQuoteRepository {
  private readonly quotes = new Map<string, MintQuote>();

  private makeKey(mintUrl: string, method: string, quoteId: string): string {
    return `${normalizeMintUrl(mintUrl)}::${method}::${quoteId}`;
  }

  async getMintQuoteById(identity: QuoteIdentity): Promise<MintQuote | null> {
    const normalizedMintUrl = normalizeMintUrl(identity.mintUrl);
    const matches = Array.from(this.quotes.values()).filter(
      (quote) => quote.mintUrl === normalizedMintUrl && quote.quoteId === identity.quoteId,
    );
    if (matches.length > 1) {
      throw new QuoteIdentityConflictError(
        'mint',
        normalizedMintUrl,
        identity.quoteId,
        matches.map((quote) => quote.method),
      );
    }
    return matches[0] ? { ...matches[0] } : null;
  }

  async getMintQuote(mintUrl: string, method: string, quoteId: string): Promise<MintQuote | null> {
    const key = this.makeKey(mintUrl, method, quoteId);
    const quote = this.quotes.get(key);
    return quote ? { ...quote } : null;
  }

  async upsertMintQuote(quote: MintQuote): Promise<void> {
    const normalizedMintUrl = normalizeMintUrl(quote.mintUrl);
    const now = Date.now();
    const identityOwner = await this.getMintQuoteById({
      mintUrl: normalizedMintUrl,
      quoteId: quote.quoteId,
    });
    if (identityOwner && identityOwner.method !== quote.method) {
      throw new QuoteIdentityConflictError(
        'mint',
        normalizedMintUrl,
        quote.quoteId,
        [identityOwner.method, quote.method],
        `Mint quote ${quote.quoteId} at ${normalizedMintUrl} already exists for method ${identityOwner.method}`,
      );
    }
    const existing = await this.getMintQuote(normalizedMintUrl, quote.method, quote.quoteId);
    const key = this.makeKey(normalizedMintUrl, quote.method, quote.quoteId);
    this.quotes.set(key, {
      ...quote,
      mintUrl: normalizedMintUrl,
      quote: quote.quoteId,
      createdAt: existing?.createdAt ?? quote.createdAt,
      updatedAt: now,
    });
  }

  async setMintQuoteState(
    mintUrl: string,
    method: string,
    quoteId: string,
    state: MintMethodRemoteState,
    observedAt = Date.now(),
  ): Promise<void> {
    const key = this.makeKey(mintUrl, method, quoteId);
    const existing = this.quotes.get(key);
    if (!existing) return;
    if (!isStatefulMintQuote(existing)) return;
    this.quotes.set(key, {
      ...existing,
      state,
      ...deriveMintQuoteAccountingFromState(state, existing.amount),
      updatedAt: observedAt,
    });
  }

  async getPendingMintQuotes(method?: string): Promise<MintQuote[]> {
    const result: MintQuote[] = [];
    for (const q of this.quotes.values()) {
      if (method && q.method !== method) continue;
      if (isMintQuotePending(q)) result.push({ ...q });
    }
    return result;
  }
}
