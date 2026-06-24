import type { MintQuoteRepository } from '@cashu/coco-core/adapter';
import {
  deserializeAmount,
  getMintQuoteAmount,
  getMintQuoteRemoteState,
  isMintQuotePending,
  isStatefulMintQuote,
  normalizeMintUrl,
  QuoteIdentityConflictError,
  serializeAmount,
  stringifyJson,
  type MintMethodRemoteState,
  type MintQuote,
  type QuoteIdentity,
} from '@cashu/coco-core/adapter';
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

export class IdbMintQuoteRepository implements MintQuoteRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getMintQuoteById(identity: QuoteIdentity): Promise<MintQuote | null> {
    const normalizedMintUrl = normalizeMintUrl(identity.mintUrl);
    const rows = (await (this.db as any)
      .table('coco_cashu_canonical_mint_quotes')
      .where('[mintUrl+quoteId]')
      .equals([normalizedMintUrl, identity.quoteId])
      .toArray()) as MintQuoteRow[];
    if (rows.length > 1) {
      throw new QuoteIdentityConflictError(
        'mint',
        normalizedMintUrl,
        identity.quoteId,
        rows.map((row) => row.method),
      );
    }
    return rows[0] ? rowToMintQuote(rows[0]) : null;
  }

  async getMintQuote(mintUrl: string, method: string, quoteId: string): Promise<MintQuote | null> {
    const row = (await (this.db as any)
      .table('coco_cashu_canonical_mint_quotes')
      .get([normalizeMintUrl(mintUrl), method, quoteId])) as MintQuoteRow | undefined;
    return row ? rowToMintQuote(row) : null;
  }

  async upsertMintQuote(quote: MintQuote): Promise<void> {
    const now = Date.now();
    const normalizedMintUrl = normalizeMintUrl(quote.mintUrl);
    const identityOwner = await this.getMintQuoteById({
      mintUrl: normalizedMintUrl,
      quoteId: quote.quoteId,
    });
    if (identityOwner && identityOwner.method !== quote.method) {
      throw new QuoteIdentityConflictError(
        'mint',
        normalizedMintUrl,
        quote.quoteId,
        [identityOwner.method, quote.method],
        `Mint quote ${quote.quoteId} at ${normalizedMintUrl} already exists for method ${identityOwner.method}`,
      );
    }
    const state = getMintQuoteRemoteState(quote) ?? null;
    const amount = getMintQuoteAmount(quote);
    const row: MintQuoteRow = {
      mintUrl: normalizedMintUrl,
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
