import type { MintQuoteBolt11Response } from '@cashu/cashu-ts';

export interface MintQuote extends Omit<MintQuoteBolt11Response, 'amount'> {
  amount: number;
  mintUrl: string;
}
