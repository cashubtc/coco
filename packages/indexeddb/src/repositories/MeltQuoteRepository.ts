import type { MeltQuoteRepository } from '@cashu/coco-core';
import { deserializeAmount, normalizeMintUrl, serializeAmount } from '@cashu/coco-core';
import type { MeltQuote } from '@cashu/coco-core';
import type { IdbDb, MeltQuoteRow } from '../lib/db.ts';

function rowToQuote(row: MeltQuoteRow): MeltQuote {
  const base = {
    mintUrl: row.mintUrl,
    method: row.method as MeltQuote['method'],
    quoteId: row.quoteId,
    quote: row.quoteId,
    state: row.state,
    request: row.request,
    amount: deserializeAmount(row.amount),
    unit: row.unit,
    expiry: row.expiry,
    change: row.change ?? undefined,
    lastObservedRemoteState: row.lastObservedRemoteState ?? undefined,
    lastObservedRemoteStateAt: row.lastObservedRemoteStateAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  if (row.method === 'onchain') {
    if (!row.fee_options || row.fee_options.length === 0) {
      throw new Error(`Stored onchain melt quote ${row.quoteId} is missing fee_options`);
    }

    return {
      ...base,
      method: 'onchain',
      fee_options: row.fee_options.map((option) => ({
        ...option,
        fee_reserve: deserializeAmount(option.fee_reserve),
      })),
      outpoint: row.outpoint ?? undefined,
    };
  }

  if (row.fee_reserve === null || row.fee_reserve === undefined) {
    throw new Error(`Stored BOLT melt quote ${row.quoteId} is missing fee_reserve`);
  }

  return {
    ...base,
    method: row.method as 'bolt11' | 'bolt12',
    fee_reserve: deserializeAmount(row.fee_reserve),
    payment_preimage: row.payment_preimage ?? undefined,
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
      fee_reserve: quote.method === 'onchain' ? null : serializeAmount(quote.fee_reserve),
      fee_options:
        quote.method === 'onchain'
          ? quote.fee_options.map((option) => ({
              ...option,
              fee_reserve: serializeAmount(option.fee_reserve),
            }))
          : undefined,
      outpoint: quote.method === 'onchain' ? (quote.outpoint ?? null) : null,
      expiry: quote.expiry,
      payment_preimage: quote.method === 'onchain' ? null : (quote.payment_preimage ?? null),
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
