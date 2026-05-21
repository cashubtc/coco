import {
  deserializeAmount,
  normalizeMintUrl,
  serializeAmount,
  type MintQuoteRepository,
  type MintQuote,
} from '@cashu/coco-core';
import { SqliteDb } from '../db.ts';

export class SqliteMintQuoteRepository implements MintQuoteRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async getMintQuote(mintUrl: string, method: string, quoteId: string): Promise<MintQuote | null> {
    const row = await this.db.get<{
      mintUrl: string;
      method: string;
      quoteId: string;
      state: string;
      request: string;
      amount: string | number;
      unit: string;
      expiry: number | null;
      pubkey?: string | null;
      lastObservedRemoteState?: string | null;
      lastObservedRemoteStateAt?: number | null;
      reusable: number;
      createdAt: number;
      updatedAt: number;
    }>(
      `SELECT mintUrl, method, quoteId, state, request, amount, unit, expiry, pubkey,
              lastObservedRemoteState, lastObservedRemoteStateAt, reusable, createdAt, updatedAt
       FROM coco_cashu_mint_quotes
       WHERE mintUrl = ? AND method = ? AND quoteId = ? LIMIT 1`,
      [normalizeMintUrl(mintUrl), method, quoteId],
    );
    if (!row) return null;
    return {
      mintUrl: row.mintUrl,
      method: row.method as MintQuote['method'],
      quoteId: row.quoteId,
      quote: row.quoteId,
      state: row.state as MintQuote['state'],
      request: row.request,
      amount: deserializeAmount(row.amount),
      unit: row.unit,
      expiry: row.expiry,
      pubkey: row.pubkey ?? undefined,
      lastObservedRemoteState: (row.lastObservedRemoteState ?? undefined) as
        | MintQuote['state']
        | undefined,
      lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
      reusable: row.reusable === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies MintQuote;
  }

  async upsertMintQuote(quote: MintQuote): Promise<void> {
    const now = Date.now();
    await this.db.run(
      `INSERT INTO coco_cashu_mint_quotes
         (mintUrl, method, quoteId, state, request, amount, unit, expiry, pubkey,
          lastObservedRemoteState, lastObservedRemoteStateAt, reusable, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mintUrl, method, quoteId) DO UPDATE SET
         state=excluded.state,
         request=excluded.request,
         amount=excluded.amount,
         unit=excluded.unit,
         expiry=excluded.expiry,
         pubkey=excluded.pubkey,
         lastObservedRemoteState=excluded.lastObservedRemoteState,
         lastObservedRemoteStateAt=excluded.lastObservedRemoteStateAt,
         reusable=excluded.reusable,
         updatedAt=excluded.updatedAt`,
      [
        normalizeMintUrl(quote.mintUrl),
        quote.method,
        quote.quoteId,
        quote.state,
        quote.request,
        serializeAmount(quote.amount),
        quote.unit,
        quote.expiry,
        quote.pubkey ?? null,
        quote.lastObservedRemoteState ?? quote.state,
        quote.lastObservedRemoteStateAt ?? now,
        quote.reusable ? 1 : 0,
        quote.createdAt,
        quote.updatedAt || now,
      ],
    );
  }

  async setMintQuoteState(
    mintUrl: string,
    method: string,
    quoteId: string,
    state: MintQuote['state'],
    observedAt = Date.now(),
  ): Promise<void> {
    await this.db.run(
      `UPDATE coco_cashu_mint_quotes
       SET state = ?, lastObservedRemoteState = ?, lastObservedRemoteStateAt = ?, updatedAt = ?
       WHERE mintUrl = ? AND method = ? AND quoteId = ?`,
      [state, state, observedAt, observedAt, normalizeMintUrl(mintUrl), method, quoteId],
    );
  }

  async getPendingMintQuotes(method?: string): Promise<MintQuote[]> {
    const rows = await this.db.all<{
      mintUrl: string;
      method: string;
      quoteId: string;
      state: string;
      request: string;
      amount: string | number;
      unit: string;
      expiry: number | null;
      pubkey?: string | null;
      lastObservedRemoteState?: string | null;
      lastObservedRemoteStateAt?: number | null;
      reusable: number;
      createdAt: number;
      updatedAt: number;
    }>(
      `SELECT mintUrl, method, quoteId, state, request, amount, unit, expiry, pubkey,
              lastObservedRemoteState, lastObservedRemoteStateAt, reusable, createdAt, updatedAt
       FROM coco_cashu_mint_quotes
       WHERE state != 'ISSUED' ${method ? 'AND method = ?' : ''}`,
      method ? [method] : [],
    );
    return rows.map(
      (row) =>
        ({
          mintUrl: row.mintUrl,
          method: row.method as MintQuote['method'],
          quoteId: row.quoteId,
          quote: row.quoteId,
          state: row.state as MintQuote['state'],
          request: row.request,
          amount: deserializeAmount(row.amount),
          unit: row.unit,
          expiry: row.expiry,
          pubkey: row.pubkey ?? undefined,
          lastObservedRemoteState: (row.lastObservedRemoteState ?? undefined) as
            | MintQuote['state']
            | undefined,
          lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
          reusable: row.reusable === 1,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }) satisfies MintQuote,
    );
  }
}
