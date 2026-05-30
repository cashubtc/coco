import type { MintQuoteRepository } from '@cashu/coco-core';
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
} from '@cashu/coco-core';
import type { IdbDb, MintQuoteRow } from '../lib/db.ts';

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
  if (row.method === 'onchain') {
    const pubkey = quoteData.pubkey ?? row.pubkey ?? '';
    return {
      mintUrl: row.mintUrl,
      method: 'onchain',
      quoteId: row.quoteId,
      quote: row.quoteId,
      request: row.request,
      unit: row.unit,
      expiry: row.expiry,
      pubkey,
      reusable: true,
      quoteData: {
        pubkey,
        amountPaid: deserializeAmount(quoteData.amountPaid ?? 0),
        amountIssued: deserializeAmount(quoteData.amountIssued ?? 0),
      },
      lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
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

  return stringifyJson({
    pubkey: quote.quoteData.pubkey,
    amountPaid: serializeAmount(quote.quoteData.amountPaid),
    amountIssued: serializeAmount(quote.quoteData.amountIssued),
  });
}

export class IdbMintQuoteRepository implements MintQuoteRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getMintQuote(mintUrl: string, method: string, quoteId: string): Promise<MintQuote | null> {
    const row = (await (this.db as any)
      .table('coco_cashu_canonical_mint_quotes')
      .get([normalizeMintUrl(mintUrl), method, quoteId])) as MintQuoteRow | undefined;
    return row ? rowToMintQuote(row) : null;
  }

  async upsertMintQuote(quote: MintQuote): Promise<void> {
    const now = Date.now();
    const state = getMintQuoteRemoteState(quote) ?? null;
    const amount = getMintQuoteAmount(quote);
    const row: MintQuoteRow = {
      mintUrl: normalizeMintUrl(quote.mintUrl),
      method: quote.method,
      quoteId: quote.quoteId,
      state,
      request: quote.request,
      amount: amount ? serializeAmount(amount) : null,
      unit: quote.unit,
      expiry: quote.expiry,
      pubkey: quote.pubkey ?? null,
      quoteDataJson: serializeQuoteData(quote),
      lastObservedRemoteState: getMintQuoteRemoteState(quote) ?? null,
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
    state: MintMethodRemoteState,
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
      .map(rowToMintQuote)
      .filter((quote) => (!method || quote.method === method) && isMintQuotePending(quote));
  }
}
