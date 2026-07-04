import type { MintQuoteRepository } from '@cashu/coco-core/adapter';
import {
  deserializeAmount,
  getMintQuoteAmount,
  getMintQuoteRemoteState,
  deriveBolt11MintQuoteStateFromAccounting,
  deriveMintQuoteAccountingFromState,
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
  const amountPaid = deserializeAmount(row.amountPaid ?? quoteData.amountPaid ?? 0);
  const amountIssued = deserializeAmount(row.amountIssued ?? quoteData.amountIssued ?? 0);
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
      amountPaid,
      amountIssued,
      remoteUpdatedAt: row.remoteUpdatedAt ?? null,
      quoteData: {
        pubkey,
        ...(amount !== undefined ? { amount } : {}),
        amountPaid,
        amountIssued,
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } as MintQuote;
  }

  const amount = deserializeAmount(quoteData.amount ?? row.amount ?? 0);
  const accounting =
    row.amountPaid !== undefined && row.amountIssued !== undefined
      ? { amountPaid, amountIssued }
      : deriveMintQuoteAccountingFromState(
          (row.state ?? 'UNPAID') as MintMethodRemoteState,
          amount,
        );
  const state = (row.state ??
    deriveBolt11MintQuoteStateFromAccounting(
      accounting.amountPaid,
      accounting.amountIssued,
    )) as MintMethodRemoteState;
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
    reusable: false,
    amountPaid: accounting.amountPaid,
    amountIssued: accounting.amountIssued,
    remoteUpdatedAt: row.remoteUpdatedAt ?? null,
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
    });
  }

  return stringifyJson({
    pubkey: quote.quoteData.pubkey,
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
      amountPaid: serializeAmount(quote.amountPaid),
      amountIssued: serializeAmount(quote.amountIssued),
      remoteUpdatedAt: quote.remoteUpdatedAt,
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
    const existingQuote = rowToMintQuote(existing);
    if (!isStatefulMintQuote(existingQuote)) return;
    const accounting = deriveMintQuoteAccountingFromState(state, existingQuote.amount);
    await (this.db as any).table('coco_cashu_canonical_mint_quotes').put({
      ...existing,
      state,
      amountPaid: serializeAmount(accounting.amountPaid),
      amountIssued: serializeAmount(accounting.amountIssued),
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
