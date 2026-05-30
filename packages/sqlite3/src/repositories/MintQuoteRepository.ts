import {
  deserializeAmount,
  getMintQuoteAmount,
  getMintQuoteRemoteState,
  isMintQuotePending,
  isStatefulMintQuote,
  normalizeMintUrl,
  serializeAmount,
  stringifyJson,
  type MintMethodRemoteState,
  type MintQuote,
  type MintQuoteRepository,
} from '@cashu/coco-core';
import { SqliteDb } from '../db.ts';

type MintQuoteRow = {
  mintUrl: string;
  method: string;
  quoteId: string;
  state: string | null;
  request: string;
  amount: string | number | null;
  unit: string;
  expiry: number | null;
  pubkey?: string | null;
  quoteDataJson?: string | null;
  lastObservedRemoteState?: string | null;
  lastObservedRemoteStateAt?: number | null;
  reusable: number;
  createdAt: number;
  updatedAt: number;
};

type SerializedQuoteData = {
  amount?: string | number;
  pubkey?: string;
  amountPaid?: string | number;
  amountIssued?: string | number;
};

function parseQuoteData(value: string | null | undefined): SerializedQuoteData {
  if (!value) return {};
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === 'object' ? (parsed as SerializedQuoteData) : {};
}

function rowToMintQuote(row: MintQuoteRow): MintQuote {
  const quoteData = parseQuoteData(row.quoteDataJson);
  if (row.method === 'onchain' || row.method === 'bolt12') {
    const pubkey = quoteData.pubkey ?? row.pubkey ?? '';
    const amountValue = quoteData.amount ?? row.amount ?? undefined;
    const amount =
      row.method === 'bolt12' && amountValue !== undefined
        ? deserializeAmount(amountValue)
        : undefined;
    return {
      mintUrl: row.mintUrl,
      method: row.method,
      quoteId: row.quoteId,
      quote: row.quoteId,
      request: row.request,
      unit: row.unit,
      ...(amount !== undefined ? { amount } : {}),
      expiry: row.expiry,
      pubkey,
      reusable: true,
      quoteData: {
        pubkey,
        ...(amount !== undefined ? { amount } : {}),
        amountPaid: deserializeAmount(quoteData.amountPaid ?? 0),
        amountIssued: deserializeAmount(quoteData.amountIssued ?? 0),
      },
      lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as MintQuote;
  }

  const amount = deserializeAmount(quoteData.amount ?? row.amount ?? 0);
  const state = (row.state ?? row.lastObservedRemoteState ?? 'UNPAID') as MintMethodRemoteState;
  return {
    mintUrl: row.mintUrl,
    method: 'bolt11',
    quoteId: row.quoteId,
    quote: row.quoteId,
    state,
    request: row.request,
    amount,
    unit: row.unit,
    expiry: row.expiry,
    pubkey: row.pubkey ?? undefined,
    lastObservedRemoteState: (row.lastObservedRemoteState ?? state) as MintMethodRemoteState,
    lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
    reusable: false,
    quoteData: { amount },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeQuoteData(quote: MintQuote): string {
  if (isStatefulMintQuote(quote)) {
    return stringifyJson({ amount: serializeAmount(quote.quoteData.amount) });
  }

  if (quote.method === 'bolt12') {
    const amount = quote.quoteData.amount ?? quote.amount;
    return stringifyJson({
      pubkey: quote.quoteData.pubkey,
      ...(amount !== undefined ? { amount: serializeAmount(amount) } : {}),
      amountPaid: serializeAmount(quote.quoteData.amountPaid),
      amountIssued: serializeAmount(quote.quoteData.amountIssued),
    });
  }

  return stringifyJson({
    pubkey: quote.quoteData.pubkey,
    amountPaid: serializeAmount(quote.quoteData.amountPaid),
    amountIssued: serializeAmount(quote.quoteData.amountIssued),
  });
}

export class SqliteMintQuoteRepository implements MintQuoteRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async getMintQuote(mintUrl: string, method: string, quoteId: string): Promise<MintQuote | null> {
    const row = await this.db.get<MintQuoteRow>(
      `SELECT mintUrl, method, quoteId, state, request, amount, unit, expiry, pubkey,
              quoteDataJson, lastObservedRemoteState, lastObservedRemoteStateAt, reusable,
              createdAt, updatedAt
       FROM coco_cashu_canonical_mint_quotes
       WHERE mintUrl = ? AND method = ? AND quoteId = ? LIMIT 1`,
      [normalizeMintUrl(mintUrl), method, quoteId],
    );
    return row ? rowToMintQuote(row) : null;
  }

  async upsertMintQuote(quote: MintQuote): Promise<void> {
    const now = Date.now();
    const state = getMintQuoteRemoteState(quote) ?? null;
    const amount = getMintQuoteAmount(quote);
    await this.db.run(
      `INSERT INTO coco_cashu_canonical_mint_quotes
         (mintUrl, method, quoteId, state, request, amount, unit, expiry, pubkey, quoteDataJson,
          lastObservedRemoteState, lastObservedRemoteStateAt, reusable, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mintUrl, method, quoteId) DO UPDATE SET
         state=excluded.state,
         request=excluded.request,
         amount=excluded.amount,
         unit=excluded.unit,
         expiry=excluded.expiry,
         pubkey=excluded.pubkey,
         quoteDataJson=excluded.quoteDataJson,
         lastObservedRemoteState=excluded.lastObservedRemoteState,
         lastObservedRemoteStateAt=excluded.lastObservedRemoteStateAt,
         reusable=excluded.reusable,
         updatedAt=excluded.updatedAt`,
      [
        normalizeMintUrl(quote.mintUrl),
        quote.method,
        quote.quoteId,
        state,
        quote.request,
        amount ? serializeAmount(amount) : null,
        quote.unit,
        quote.expiry,
        quote.pubkey ?? null,
        serializeQuoteData(quote),
        getMintQuoteRemoteState(quote) ?? null,
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
    state: MintMethodRemoteState,
    observedAt = Date.now(),
  ): Promise<void> {
    await this.db.run(
      `UPDATE coco_cashu_canonical_mint_quotes
       SET state = ?, lastObservedRemoteState = ?, lastObservedRemoteStateAt = ?, updatedAt = ?
       WHERE mintUrl = ? AND method = ? AND quoteId = ?`,
      [state, state, observedAt, observedAt, normalizeMintUrl(mintUrl), method, quoteId],
    );
  }

  async getPendingMintQuotes(method?: string): Promise<MintQuote[]> {
    const rows = await this.db.all<MintQuoteRow>(
      `SELECT mintUrl, method, quoteId, state, request, amount, unit, expiry, pubkey,
              quoteDataJson, lastObservedRemoteState, lastObservedRemoteStateAt, reusable,
              createdAt, updatedAt
       FROM coco_cashu_canonical_mint_quotes
       WHERE (state IS NULL OR state != 'ISSUED') ${method ? 'AND method = ?' : ''}`,
      method ? [method] : [],
    );
    return rows.map(rowToMintQuote).filter(isMintQuotePending);
  }
}
