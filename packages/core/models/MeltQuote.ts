import type { MeltQuoteBolt11Response } from '@cashu/cashu-ts';

export interface MeltQuote extends MeltQuoteBolt11Response {
  mintUrl: string;
}
