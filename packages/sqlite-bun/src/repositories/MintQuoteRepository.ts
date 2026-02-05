import type { MintQuoteRepository } from 'coco-cashu-core';
import type { MintQuote } from 'coco-cashu-core';
import { SqliteDb } from '../db.ts';

export class SqliteMintQuoteRepository implements MintQuoteRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async getMintQuote(mintUrl: string, quoteId: string): Promise<MintQuote | null> {
    const row = await this.db.get<{
      mintUrl: string;
      quote: string;
      state: string;
      request: string;
      amount: number;
      unit: string;
      expiry: number;
      pubkey?: string | null;
    }>(
      `SELECT mintUrl, quote, state, request, amount, unit, expiry, pubkey
       FROM coco_cashu_mint_quotes WHERE mintUrl = ? AND quote = ? LIMIT 1`,
      [mintUrl, quoteId],
    );
    if (!row) return null;
    return {
      mintUrl: row.mintUrl,
      quote: row.quote,
      state: row.state as MintQuote['state'],
      request: row.request,
      amount: row.amount,
      unit: row.unit,
      expiry: row.expiry,
      pubkey: row.pubkey ?? undefined,
    } satisfies MintQuote;
  }

  async addMintQuote(quote: MintQuote): Promise<void> {
    await this.db.run(
      `INSERT INTO coco_cashu_mint_quotes (mintUrl, quote, state, request, amount, unit, expiry, pubkey)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mintUrl, quote) DO UPDATE SET
         state=excluded.state,
         request=excluded.request,
         amount=excluded.amount,
         unit=excluded.unit,
         expiry=excluded.expiry,
         pubkey=excluded.pubkey`,
      [
        quote.mintUrl,
        quote.quote,
        quote.state,
        quote.request,
        quote.amount,
        quote.unit,
        quote.expiry,
        quote.pubkey ?? null,
      ],
    );
  }

  async setMintQuoteState(
    mintUrl: string,
    quoteId: string,
    state: MintQuote['state'],
  ): Promise<void> {
    await this.db.run(
      'UPDATE coco_cashu_mint_quotes SET state = ? WHERE mintUrl = ? AND quote = ?',
      [state, mintUrl, quoteId],
    );
  }

  async getPendingMintQuotes(): Promise<MintQuote[]> {
    const rows = await this.db.all<{
      mintUrl: string;
      quote: string;
      state: string;
      request: string;
      amount: number;
      unit: string;
      expiry: number;
      pubkey?: string | null;
    }>(
      `SELECT mintUrl, quote, state, request, amount, unit, expiry, pubkey
       FROM coco_cashu_mint_quotes WHERE state != 'ISSUED'`,
    );
    return rows.map(
      (row) =>
        ({
          mintUrl: row.mintUrl,
          quote: row.quote,
          state: row.state as MintQuote['state'],
          request: row.request,
          amount: row.amount,
          unit: row.unit,
          expiry: row.expiry,
          pubkey: row.pubkey ?? undefined,
        } satisfies MintQuote),
    );
  }
}
