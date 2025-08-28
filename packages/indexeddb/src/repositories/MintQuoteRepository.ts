import type { MintQuoteRepository } from 'coco-cashu-core';
import type { MintQuote } from 'coco-cashu-core';
import type { IdbDb, MintQuoteRow } from '../lib/db.ts';

export class IdbMintQuoteRepository implements MintQuoteRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getMintQuote(mintUrl: string, quoteId: string): Promise<MintQuote | null> {
    const row = (await (this.db as any).table('coco_cashu_mint_quotes').get([mintUrl, quoteId])) as
      | MintQuoteRow
      | undefined;
    if (!row) return null;
    const quote: MintQuote = {
      mintUrl: row.mintUrl,
      quote: row.quote,
      state: row.state,
      request: row.request,
      amount: row.amount,
      unit: row.unit,
      expiry: row.expiry,
      pubkey: row.pubkey ?? undefined,
    };
    return quote;
  }

  async addMintQuote(quote: MintQuote): Promise<void> {
    const row: MintQuoteRow = {
      mintUrl: quote.mintUrl,
      quote: quote.quote,
      state: quote.state,
      request: quote.request,
      amount: quote.amount,
      unit: quote.unit,
      expiry: quote.expiry,
      pubkey: quote.pubkey ?? null,
    };
    await (this.db as any).table('coco_cashu_mint_quotes').put(row);
  }

  async setMintQuoteState(
    mintUrl: string,
    quoteId: string,
    state: MintQuote['state'],
  ): Promise<void> {
    const existing = (await (this.db as any)
      .table('coco_cashu_mint_quotes')
      .get([mintUrl, quoteId])) as MintQuoteRow | undefined;
    if (!existing) return;
    await (this.db as any)
      .table('coco_cashu_mint_quotes')
      .put({ ...existing, state } as MintQuoteRow);
  }
}
