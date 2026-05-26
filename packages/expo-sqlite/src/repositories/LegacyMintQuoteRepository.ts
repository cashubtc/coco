import {
  deserializeAmount,
  normalizeMintUrl,
  type LegacyMintQuoteRepository,
  type MintQuote,
} from '@cashu/coco-core';
import { ExpoSqliteDb } from '../db.ts';

export class ExpoLegacyMintQuoteRepository implements LegacyMintQuoteRepository {
  constructor(private readonly db: ExpoSqliteDb) {}

  async getPendingLegacyMintQuotes(mintUrl?: string): Promise<MintQuote[]> {
    const normalizedMintUrl = mintUrl ? normalizeMintUrl(mintUrl) : undefined;
    const rows = await this.db.all<{
      mintUrl: string;
      quote: string;
      state: string;
      request: string;
      amount: string | number;
      unit: string;
      expiry: number | null;
      pubkey?: string | null;
    }>(
      `SELECT mintUrl, quote, state, request, amount, unit, expiry, pubkey
       FROM coco_cashu_mint_quotes
       WHERE state != 'ISSUED' ${normalizedMintUrl ? 'AND mintUrl = ?' : ''}`,
      normalizedMintUrl ? [normalizedMintUrl] : [],
    );

    const now = Date.now();
    return rows.map(
      (row) =>
        ({
          mintUrl: row.mintUrl,
          method: 'bolt11',
          quoteId: row.quote,
          quote: row.quote,
          state: row.state as MintQuote['state'],
          request: row.request,
          amount: deserializeAmount(row.amount),
          unit: row.unit,
          expiry: row.expiry,
          pubkey: row.pubkey ?? undefined,
          lastObservedRemoteState: row.state as MintQuote['state'],
          lastObservedRemoteStateAt: now,
          reusable: false,
          createdAt: now,
          updatedAt: now,
        }) satisfies MintQuote,
    );
  }
}
