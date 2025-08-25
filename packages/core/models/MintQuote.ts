import type { MintQuoteResponse } from '@cashu/cashu-ts';

export interface MintQuote extends MintQuoteResponse {
  mintUrl: string;
}
