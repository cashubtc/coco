import type { MintQuoteRepository } from '@cashu/coco-core';
import { deserializeAmount, normalizeMintUrl, serializeAmount } from '@cashu/coco-core';
import type { MintQuote } from '@cashu/coco-core';
import type { IdbDb, MintQuoteRow } from '../lib/db.ts';

export class IdbMintQuoteRepository implements MintQuoteRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getMintQuote(mintUrl: string, method: string, quoteId: string): Promise<MintQuote | null> {
    const row = (await (this.db as any)
      .table('coco_cashu_canonical_mint_quotes')
      .get([normalizeMintUrl(mintUrl), method, quoteId])) as MintQuoteRow | undefined;
    if (!row) return null;
    const quote: MintQuote = {
      mintUrl: row.mintUrl,
      method: row.method as MintQuote['method'],
      quoteId: row.quoteId,
      quote: row.quoteId,
      state: row.state,
      request: row.request,
      amount: deserializeAmount(row.amount),
      unit: row.unit,
      expiry: row.expiry,
      pubkey: row.pubkey ?? undefined,
      lastObservedRemoteState: row.lastObservedRemoteState ?? undefined,
      lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
      reusable: row.reusable === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return quote;
  }

  async upsertMintQuote(quote: MintQuote): Promise<void> {
    const now = Date.now();
    const row: MintQuoteRow = {
      mintUrl: normalizeMintUrl(quote.mintUrl),
      method: quote.method,
      quoteId: quote.quoteId,
      state: quote.state,
      request: quote.request,
      amount: serializeAmount(quote.amount),
      unit: quote.unit,
      expiry: quote.expiry,
      pubkey: quote.pubkey ?? null,
      lastObservedRemoteState: quote.lastObservedRemoteState ?? quote.state,
      lastObservedRemoteStateAt: quote.lastObservedRemoteStateAt ?? now,
      reusable: quote.reusable ? 1 : 0,
      createdAt: quote.createdAt,
      updatedAt: quote.updatedAt || now,
    };
    await (this.db as any).table('coco_cashu_canonical_mint_quotes').put(row);
  }

  async setMintQuoteState(
    mintUrl: string,
    method: string,
    quoteId: string,
    state: MintQuote['state'],
    observedAt = Date.now(),
  ): Promise<void> {
    const existing = (await (this.db as any)
      .table('coco_cashu_canonical_mint_quotes')
      .get([normalizeMintUrl(mintUrl), method, quoteId])) as MintQuoteRow | undefined;
    if (!existing) return;
    await (this.db as any).table('coco_cashu_canonical_mint_quotes').put({
      ...existing,
      state,
      lastObservedRemoteState: state,
      lastObservedRemoteStateAt: observedAt,
      updatedAt: observedAt,
    } as MintQuoteRow);
  }

  async getPendingMintQuotes(method?: string): Promise<MintQuote[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_canonical_mint_quotes')
      .toArray()) as MintQuoteRow[];
    return rows
      .filter((r) => r.state !== 'ISSUED' && (!method || r.method === method))
      .map((row) => ({
        mintUrl: row.mintUrl,
        method: row.method as MintQuote['method'],
        quoteId: row.quoteId,
        quote: row.quoteId,
        state: row.state,
        request: row.request,
        amount: deserializeAmount(row.amount),
        unit: row.unit,
        expiry: row.expiry,
        pubkey: row.pubkey ?? undefined,
        lastObservedRemoteState: row.lastObservedRemoteState ?? undefined,
        lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
        reusable: row.reusable === 1,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  }
}
