import {
  deserializeAmount,
  normalizeMintUrl,
  serializeAmount,
  stringifyJson,
  type MeltQuote,
  type MeltQuoteRepository,
} from '@cashu/coco-core';
import { ExpoSqliteDb } from '../db.ts';

type MeltQuoteRow = {
  mintUrl: string;
  method: string;
  quoteId: string;
  state: string;
  request: string;
  amount: string | number;
  unit: string;
  fee_reserve?: string | number | null;
  expiry: number;
  payment_preimage?: string | null;
  fee_options_json?: string | null;
  outpoint?: string | null;
  changeJson?: string | null;
  lastObservedRemoteState?: string | null;
  lastObservedRemoteStateAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

function rowToQuote(row: MeltQuoteRow): MeltQuote {
  const base = {
    mintUrl: row.mintUrl,
    method: row.method as MeltQuote['method'],
    quoteId: row.quoteId,
    quote: row.quoteId,
    state: row.state as MeltQuote['state'],
    request: row.request,
    amount: deserializeAmount(row.amount),
    unit: row.unit,
    expiry: row.expiry,
    change: row.changeJson ? JSON.parse(row.changeJson) : undefined,
    lastObservedRemoteState: (row.lastObservedRemoteState ?? undefined) as
      | MeltQuote['state']
      | undefined,
    lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  if (row.method === 'onchain') {
    const feeOptions = row.fee_options_json ? JSON.parse(row.fee_options_json) : undefined;
    if (!Array.isArray(feeOptions) || feeOptions.length === 0) {
      throw new Error(`Stored onchain melt quote ${row.quoteId} is missing fee_options`);
    }
    return {
      ...base,
      method: 'onchain',
      fee_options: feeOptions.map((option) => ({
        ...option,
        fee_reserve: deserializeAmount(option.fee_reserve),
      })),
      outpoint: row.outpoint ?? undefined,
    } satisfies MeltQuote<'onchain'>;
  }

  if (row.fee_reserve === null || row.fee_reserve === undefined) {
    throw new Error(`Stored BOLT melt quote ${row.quoteId} is missing fee_reserve`);
  }

  return {
    ...base,
    method: row.method as 'bolt11' | 'bolt12',
    fee_reserve: deserializeAmount(row.fee_reserve),
    payment_preimage: row.payment_preimage ?? undefined,
  } satisfies MeltQuote<'bolt11' | 'bolt12'>;
}

export class ExpoMeltQuoteRepository implements MeltQuoteRepository {
  constructor(private readonly db: ExpoSqliteDb) {}

  async getMeltQuote(mintUrl: string, method: string, quoteId: string): Promise<MeltQuote | null> {
    const row = await this.db.get<MeltQuoteRow>(
      `SELECT mintUrl, method, quoteId, state, request, amount, unit, fee_reserve, expiry,
              payment_preimage, fee_options_json, outpoint, changeJson, lastObservedRemoteState, lastObservedRemoteStateAt,
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
          payment_preimage, fee_options_json, outpoint, changeJson, lastObservedRemoteState,
          lastObservedRemoteStateAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mintUrl, method, quoteId) DO UPDATE SET
         state=excluded.state,
         request=excluded.request,
         amount=excluded.amount,
         unit=excluded.unit,
         fee_reserve=excluded.fee_reserve,
         expiry=excluded.expiry,
         payment_preimage=excluded.payment_preimage,
         fee_options_json=excluded.fee_options_json,
         outpoint=excluded.outpoint,
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
        quote.method === 'onchain' ? null : serializeAmount(quote.fee_reserve),
        quote.expiry,
        quote.method === 'onchain' ? null : (quote.payment_preimage ?? null),
        quote.method === 'onchain'
          ? stringifyJson(
              quote.fee_options.map((option) => ({
                ...option,
                fee_reserve: serializeAmount(option.fee_reserve),
              })),
            )
          : null,
        quote.method === 'onchain' ? (quote.outpoint ?? null) : null,
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
              payment_preimage, fee_options_json, outpoint, changeJson, lastObservedRemoteState, lastObservedRemoteStateAt,
              createdAt, updatedAt
       FROM coco_cashu_melt_quotes
       WHERE state != 'PAID' ${method ? 'AND method = ?' : ''}`,
      method ? [method] : [],
    );
    return rows.map(rowToQuote);
  }
}
