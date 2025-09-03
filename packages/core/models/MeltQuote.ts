import type { MeltQuoteResponse } from '@cashu/cashu-ts';

export interface MeltQuote extends MeltQuoteResponse {
  mintUrl: string;
}
