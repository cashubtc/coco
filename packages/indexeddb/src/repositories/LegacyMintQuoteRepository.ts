import {
  deserializeAmount,
  normalizeMintUrl,
  type LegacyMintQuoteRepository,
  type MintMethodRemoteState,
  type MintQuote,
} from '@cashu/coco-core/adapter';
import type { IdbDb } from '../lib/db.ts';

type LegacyMintQuoteRow = {
  mintUrl: string;
  quote: string;
  state: MintMethodRemoteState;
  request: string;
  amount: string | number;
  unit: string;
  expiry: number | null;
  pubkey?: string | null;
};

export class IdbLegacyMintQuoteRepository implements LegacyMintQuoteRepository {
  constructor(private readonly db: IdbDb) {}

  async getPendingLegacyMintQuotes(mintUrl?: string): Promise<MintQuote[]> {
    const normalizedMintUrl = mintUrl ? normalizeMintUrl(mintUrl) : undefined;
    const rows = (await (this.db as any)
      .table('coco_cashu_mint_quotes')
      .toArray()) as LegacyMintQuoteRow[];
    const now = Date.now();

    return rows
      .filter(
        (row) =>
          row.state !== 'ISSUED' && (!normalizedMintUrl || row.mintUrl === normalizedMintUrl),
      )
      .map((row) => {
        const amount = deserializeAmount(row.amount);
        return {
          mintUrl: row.mintUrl,
          method: 'bolt11',
          quoteId: row.quote,
          quote: row.quote,
          state: row.state,
          request: row.request,
          amount,
          unit: row.unit,
          expiry: row.expiry,
          pubkey: row.pubkey ?? undefined,
          lastObservedRemoteState: row.state,
          lastObservedRemoteStateAt: now,
          reusable: false,
          quoteData: { amount },
          createdAt: now,
          updatedAt: now,
        };
      });
  }
}
