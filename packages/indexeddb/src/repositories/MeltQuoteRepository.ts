import type { MeltQuoteRepository } from '@cashu/coco-core';
import { deserializeAmount, normalizeMintUrl, serializeAmount } from '@cashu/coco-core';
import type { MeltQuote } from '@cashu/coco-core';
import type { IdbDb, MeltQuoteRow } from '../lib/db.ts';

function rowToQuote(row: MeltQuoteRow): MeltQuote {
  return {
    mintUrl: row.mintUrl,
    method: row.method as MeltQuote['method'],
    quoteId: row.quoteId,
    quote: row.quoteId,
    state: row.state,
    request: row.request,
    amount: deserializeAmount(row.amount),
    unit: row.unit,
    fee_reserve: deserializeAmount(row.fee_reserve),
    expiry: row.expiry,
    payment_preimage: row.payment_preimage ?? undefined,
    change: row.change ?? undefined,
    lastObservedRemoteState: row.lastObservedRemoteState ?? undefined,
    lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class IdbMeltQuoteRepository implements MeltQuoteRepository {
  constructor(private readonly db: IdbDb) {}

  async getMeltQuote(mintUrl: string, method: string, quoteId: string): Promise<MeltQuote | null> {
    const row = (await (this.db as any)
      .table('coco_cashu_melt_quotes')
      .get([normalizeMintUrl(mintUrl), method, quoteId])) as MeltQuoteRow | undefined;
    return row ? rowToQuote(row) : null;
  }

  async upsertMeltQuote(quote: MeltQuote): Promise<void> {
    const now = Date.now();
    const existing = await this.getMeltQuote(quote.mintUrl, quote.method, quote.quoteId);
    const row: MeltQuoteRow = {
      mintUrl: normalizeMintUrl(quote.mintUrl),
      method: quote.method,
      quoteId: quote.quoteId,
      quote: quote.quoteId,
      state: quote.state,
      request: quote.request,
      amount: serializeAmount(quote.amount),
      unit: quote.unit,
      fee_reserve: serializeAmount(quote.fee_reserve),
      expiry: quote.expiry,
      payment_preimage: quote.payment_preimage ?? null,
      change: quote.change,
      lastObservedRemoteState: quote.lastObservedRemoteState ?? quote.state,
      lastObservedRemoteStateAt: quote.lastObservedRemoteStateAt ?? now,
      createdAt: existing?.createdAt ?? quote.createdAt,
      updatedAt: now,
    };
    await (this.db as any).table('coco_cashu_melt_quotes').put(row);
  }

  async getPendingMeltQuotes(method?: string): Promise<MeltQuote[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_melt_quotes')
      .toArray()) as MeltQuoteRow[];
    return rows
      .filter((row) => row.state !== 'PAID' && (!method || row.method === method))
      .map(rowToQuote);
  }
}
