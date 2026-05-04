import type { MeltQuoteBolt11Response } from '@cashu/cashu-ts';

export interface MeltQuote extends Omit<MeltQuoteBolt11Response, 'amount' | 'fee_reserve'> {
  amount: number;
  fee_reserve: number;
  mintUrl: string;
}
