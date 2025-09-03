import type { MeltQuoteRepository } from 'coco-cashu-core';
import type { MeltQuote } from 'coco-cashu-core';
import { ExpoSqliteDb } from '../db.ts';

export class ExpoMeltQuoteRepository implements MeltQuoteRepository {
  private readonly db: ExpoSqliteDb;

  constructor(db: ExpoSqliteDb) {
    this.db = db;
  }

  async getMeltQuote(mintUrl: string, quoteId: string): Promise<MeltQuote | null> {
    const row = await this.db.get<{
      mintUrl: string;
      quote: string;
      state: string;
      request: string;
      amount: number;
      unit: string;
      expiry: number;
      fee_reserve: number;
      payment_preimage: string | null;
    }>(
      `SELECT mintUrl, quote, state, request, amount, unit, expiry, fee_reserve, payment_preimage
       FROM coco_cashu_melt_quotes WHERE mintUrl = ? AND quote = ? LIMIT 1`,
      [mintUrl, quoteId],
    );
    if (!row) return null;
    return {
      mintUrl: row.mintUrl,
      quote: row.quote,
      state: row.state as MeltQuote['state'],
      request: row.request,
      amount: row.amount,
      unit: row.unit,
      expiry: row.expiry,
      fee_reserve: row.fee_reserve,
      payment_preimage: row.payment_preimage,
    } satisfies MeltQuote;
  }

  async addMeltQuote(quote: MeltQuote): Promise<void> {
    await this.db.run(
      `INSERT INTO coco_cashu_melt_quotes (mintUrl, quote, state, request, amount, unit, expiry, fee_reserve, payment_preimage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mintUrl, quote) DO UPDATE SET
         state=excluded.state,
         request=excluded.request,
         amount=excluded.amount,
         unit=excluded.unit,
         expiry=excluded.expiry,
         fee_reserve=excluded.fee_reserve,
         payment_preimage=excluded.payment_preimage`,
      [
        quote.mintUrl,
        quote.quote,
        quote.state,
        quote.request,
        quote.amount,
        quote.unit,
        quote.expiry,
        quote.fee_reserve,
        quote.payment_preimage ?? null,
      ],
    );
  }

  async setMeltQuoteState(
    mintUrl: string,
    quoteId: string,
    state: MeltQuote['state'],
  ): Promise<void> {
    await this.db.run(
      'UPDATE coco_cashu_melt_quotes SET state = ? WHERE mintUrl = ? AND quote = ?',
      [state, mintUrl, quoteId],
    );
  }

  async getPendingMeltQuotes(): Promise<MeltQuote[]> {
    const rows = await this.db.all<{
      mintUrl: string;
      quote: string;
      state: string;
      request: string;
      amount: number;
      unit: string;
      expiry: number;
      fee_reserve: number;
      payment_preimage: string | null;
    }>(
      `SELECT mintUrl, quote, state, request, amount, unit, expiry, fee_reserve, payment_preimage
       FROM coco_cashu_melt_quotes WHERE state != 'PAID'`,
    );
    return rows.map(
      (row) =>
        ({
          mintUrl: row.mintUrl,
          quote: row.quote,
          state: row.state as MeltQuote['state'],
          request: row.request,
          amount: row.amount,
          unit: row.unit,
          expiry: row.expiry,
          fee_reserve: row.fee_reserve,
          payment_preimage: row.payment_preimage,
        } satisfies MeltQuote),
    );
  }
}
