import type { MeltQuoteRepository } from 'coco-cashu-core';
import type { MeltQuote } from 'coco-cashu-core';
import type { IdbDb, MeltQuoteRow } from '../lib/db.ts';

export class IdbMeltQuoteRepository implements MeltQuoteRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getMeltQuote(mintUrl: string, quoteId: string): Promise<MeltQuote | null> {
    const row = (await (this.db as any).table('coco_cashu_melt_quotes').get([mintUrl, quoteId])) as
      | MeltQuoteRow
      | undefined;
    if (!row) return null;
    const quote: MeltQuote = {
      mintUrl: row.mintUrl,
      quote: row.quote,
      state: row.state,
      request: row.request,
      amount: row.amount,
      unit: row.unit,
      expiry: row.expiry,
      fee_reserve: row.fee_reserve,
      payment_preimage: row.payment_preimage,
    };
    return quote;
  }

  async addMeltQuote(quote: MeltQuote): Promise<void> {
    const row: MeltQuoteRow = {
      mintUrl: quote.mintUrl,
      quote: quote.quote,
      state: quote.state,
      request: quote.request,
      amount: quote.amount,
      unit: quote.unit,
      expiry: quote.expiry,
      fee_reserve: quote.fee_reserve,
      payment_preimage: quote.payment_preimage ?? null,
    };
    await (this.db as any).table('coco_cashu_melt_quotes').put(row);
  }

  async setMeltQuoteState(
    mintUrl: string,
    quoteId: string,
    state: MeltQuote['state'],
  ): Promise<void> {
    const existing = (await (this.db as any)
      .table('coco_cashu_melt_quotes')
      .get([mintUrl, quoteId])) as MeltQuoteRow | undefined;
    if (!existing) return;
    await (this.db as any)
      .table('coco_cashu_melt_quotes')
      .put({ ...existing, state } as MeltQuoteRow);
  }

  async getPendingMeltQuotes(): Promise<MeltQuote[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_melt_quotes')
      .toArray()) as MeltQuoteRow[];
    return rows
      .filter((r) => r.state !== 'PAID')
      .map((row) => ({
        mintUrl: row.mintUrl,
        quote: row.quote,
        state: row.state,
        request: row.request,
        amount: row.amount,
        unit: row.unit,
        expiry: row.expiry,
        fee_reserve: row.fee_reserve,
        payment_preimage: row.payment_preimage,
      }));
  }
}
