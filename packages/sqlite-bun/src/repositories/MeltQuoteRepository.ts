import {
  deserializeAmount,
  normalizeMintUrl,
  serializeAmount,
  stringifyJson,
  type MeltQuote,
  type MeltQuoteRepository,
} from '@cashu/coco-core';
import { SqliteDb } from '../db.ts';

type MeltQuoteRow = {
  mintUrl: string;
  method: string;
  quoteId: string;
  state: string;
  request: string;
  amount: string | number;
  unit: string;
  fee_reserve: string | number;
  expiry: number;
  payment_preimage?: string | null;
  changeJson?: string | null;
  lastObservedRemoteState?: string | null;
  lastObservedRemoteStateAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

function rowToQuote(row: MeltQuoteRow): MeltQuote {
  return {
    mintUrl: row.mintUrl,
    method: row.method as MeltQuote['method'],
    quoteId: row.quoteId,
    quote: row.quoteId,
    state: row.state as MeltQuote['state'],
    request: row.request,
    amount: deserializeAmount(row.amount),
    unit: row.unit,
    fee_reserve: deserializeAmount(row.fee_reserve),
    expiry: row.expiry,
    payment_preimage: row.payment_preimage ?? undefined,
    change: row.changeJson ? JSON.parse(row.changeJson) : undefined,
    lastObservedRemoteState: (row.lastObservedRemoteState ?? undefined) as
      | MeltQuote['state']
      | undefined,
    lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } satisfies MeltQuote;
}

export class SqliteMeltQuoteRepository implements MeltQuoteRepository {
  constructor(private readonly db: SqliteDb) {}

  async getMeltQuote(mintUrl: string, method: string, quoteId: string): Promise<MeltQuote | null> {
    const row = await this.db.get<MeltQuoteRow>(
      `SELECT mintUrl, method, quoteId, state, request, amount, unit, fee_reserve, expiry,
              payment_preimage, changeJson, lastObservedRemoteState, lastObservedRemoteStateAt,
              createdAt, updatedAt
       FROM coco_cashu_melt_quotes
       WHERE mintUrl = ? AND method = ? AND quoteId = ? LIMIT 1`,
      [normalizeMintUrl(mintUrl), method, quoteId],
    );
    return row ? rowToQuote(row) : null;
  }

  async upsertMeltQuote(quote: MeltQuote): Promise<void> {
    const now = Date.now();
    await this.db.run(
      `INSERT INTO coco_cashu_melt_quotes
         (mintUrl, method, quoteId, state, request, amount, unit, fee_reserve, expiry,
          payment_preimage, changeJson, lastObservedRemoteState, lastObservedRemoteStateAt,
          createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mintUrl, method, quoteId) DO UPDATE SET
         state=excluded.state,
         request=excluded.request,
         amount=excluded.amount,
         unit=excluded.unit,
         fee_reserve=excluded.fee_reserve,
         expiry=excluded.expiry,
         payment_preimage=excluded.payment_preimage,
         changeJson=excluded.changeJson,
         lastObservedRemoteState=excluded.lastObservedRemoteState,
         lastObservedRemoteStateAt=excluded.lastObservedRemoteStateAt,
         updatedAt=excluded.updatedAt`,
      [
        normalizeMintUrl(quote.mintUrl),
        quote.method,
        quote.quoteId,
        quote.state,
        quote.request,
        serializeAmount(quote.amount),
        quote.unit,
        serializeAmount(quote.fee_reserve),
        quote.expiry,
        quote.payment_preimage ?? null,
        quote.change ? stringifyJson(quote.change) : null,
        quote.lastObservedRemoteState ?? quote.state,
        quote.lastObservedRemoteStateAt ?? now,
        quote.createdAt,
        quote.updatedAt || now,
      ],
    );
  }

  async getPendingMeltQuotes(method?: string): Promise<MeltQuote[]> {
    const rows = await this.db.all<MeltQuoteRow>(
      `SELECT mintUrl, method, quoteId, state, request, amount, unit, fee_reserve, expiry,
              payment_preimage, changeJson, lastObservedRemoteState, lastObservedRemoteStateAt,
              createdAt, updatedAt
       FROM coco_cashu_melt_quotes
       WHERE state != 'PAID' ${method ? 'AND method = ?' : ''}`,
      method ? [method] : [],
    );
    return rows.map(rowToQuote);
  }
}
