import { Amount } from '@cashu/cashu-ts';
import {
  deserializeAmount,
  normalizeMintUrl,
  type LegacyMintQuoteRepository,
  type MintQuote,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase } from '../index.ts';

export class SqliteLegacyMintQuoteRepository implements LegacyMintQuoteRepository {
  constructor(private readonly db: SqlDatabase) {}

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
    return rows.map((row) => {
      const amount = deserializeAmount(row.amount);
      return {
        mintUrl: row.mintUrl,
        method: 'bolt11',
        quoteId: row.quote,
        quote: row.quote,
        state: row.state as MintQuote<'bolt11'>['state'],
        request: row.request,
        amount,
        unit: row.unit,
        expiry: row.expiry,
        pubkey: row.pubkey ?? undefined,
        reusable: false,
        amountPaid: row.state === 'PAID' ? amount : Amount.zero(),
        amountIssued: Amount.zero(),
        remoteUpdatedAt: null,
        quoteData: {
          amount,
        },
        createdAt: now,
        updatedAt: now,
      } satisfies MintQuote;
    });
  }
}
