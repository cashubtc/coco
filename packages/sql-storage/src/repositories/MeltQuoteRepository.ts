import {
  deserializeAmount,
  normalizeMintUrl,
  QuoteIdentityConflictError,
  serializeAmount,
  stringifyJson,
  type MeltQuote,
  type MeltQuoteRepository,
  type QuoteIdentity,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase } from '../index.ts';

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

export class SqliteMeltQuoteRepository implements MeltQuoteRepository {
  constructor(private readonly db: SqlDatabase) {}

  async getMeltQuoteById(identity: QuoteIdentity): Promise<MeltQuote | null> {
    const normalizedMintUrl = normalizeMintUrl(identity.mintUrl);
    const rows = await this.db.all<MeltQuoteRow>(
      `SELECT mintUrl, method, quoteId, state, request, amount, unit, fee_reserve, expiry,
              payment_preimage, fee_options_json, outpoint, changeJson, lastObservedRemoteState, lastObservedRemoteStateAt,
              createdAt, updatedAt
       FROM coco_cashu_melt_quotes
       WHERE mintUrl = ? AND quoteId = ?`,
      [normalizedMintUrl, identity.quoteId],
    );
    if (rows.length > 1) {
      throw new QuoteIdentityConflictError(
        'melt',
        normalizedMintUrl,
        identity.quoteId,
        rows.map((row) => row.method),
      );
    }
    return rows[0] ? rowToQuote(rows[0]) : null;
  }

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

  async upsertMeltQuote(quote: MeltQuote): Promise<MeltQuote> {
    const now = Date.now();
    const normalizedMintUrl = normalizeMintUrl(quote.mintUrl);
    const identityOwner = await this.getMeltQuoteById({
      mintUrl: normalizedMintUrl,
      quoteId: quote.quoteId,
    });
    if (identityOwner && identityOwner.method !== quote.method) {
      throw new QuoteIdentityConflictError(
        'melt',
        normalizedMintUrl,
        quote.quoteId,
        [identityOwner.method, quote.method],
        `Melt quote ${quote.quoteId} at ${normalizedMintUrl} already exists for method ${identityOwner.method}`,
      );
    }
    const row: MeltQuoteRow = {
      mintUrl: normalizedMintUrl,
      method: quote.method,
      quoteId: quote.quoteId,
      state: quote.state,
      request: quote.request,
      amount: serializeAmount(quote.amount),
      unit: quote.unit,
      fee_reserve: quote.method === 'onchain' ? null : serializeAmount(quote.fee_reserve),
      expiry: quote.expiry,
      payment_preimage: quote.method === 'onchain' ? null : (quote.payment_preimage ?? null),
      fee_options_json:
        quote.method === 'onchain'
          ? stringifyJson(
              quote.fee_options.map((option) => ({
                ...option,
                fee_reserve: serializeAmount(option.fee_reserve),
              })),
            )
          : null,
      outpoint: quote.method === 'onchain' ? (quote.outpoint ?? null) : null,
      changeJson: quote.change ? stringifyJson(quote.change) : null,
      lastObservedRemoteState: quote.lastObservedRemoteState ?? quote.state,
      lastObservedRemoteStateAt: quote.lastObservedRemoteStateAt ?? now,
      createdAt: identityOwner?.createdAt ?? quote.createdAt,
      updatedAt: quote.updatedAt || now,
    };
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
        row.mintUrl,
        row.method,
        row.quoteId,
        row.state,
        row.request,
        row.amount,
        row.unit,
        row.fee_reserve ?? null,
        row.expiry,
        row.payment_preimage ?? null,
        row.fee_options_json ?? null,
        row.outpoint ?? null,
        row.changeJson ?? null,
        row.lastObservedRemoteState ?? null,
        row.lastObservedRemoteStateAt ?? null,
        row.createdAt,
        row.updatedAt,
      ],
    );
    return rowToQuote(row);
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
