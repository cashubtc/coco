import {
  Amount,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
} from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';

import {
  getMintQuoteAmount,
  mintQuoteFromBolt11Response,
  mintQuoteFromBolt12Response,
} from '../../models/MintQuote';

describe('MintQuote model', () => {
  it('copies cashu-ts-normalized BOLT11 accounting into the canonical model', () => {
    const quote = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-1',
      request: 'lnbc...',
      method: 'bolt11',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: 123,
      amount_paid: Amount.from(100),
      amount_issued: Amount.zero(),
      updated_at: null,
      state: 'PAID',
    } satisfies MintQuoteBolt11Response);

    expect(quote.amount.equals(Amount.from(100))).toBe(true);
    expect(quote.quoteData.amount.equals(Amount.from(100))).toBe(true);
    expect(quote.amountPaid.equals(Amount.from(100))).toBe(true);
    expect(quote.amountIssued.equals(Amount.zero())).toBe(true);
    expect(quote.remoteUpdatedAt).toBe(null);
  });

  it('keeps BOLT12 offer amounts separate from mint operation amounts', () => {
    const quote = mintQuoteFromBolt12Response('https://mint.test', {
      quote: 'quote-1',
      request: 'lno1...',
      method: 'bolt12',
      amount: Amount.from(21),
      unit: 'sat',
      expiry: 123,
      pubkey: '02'.padEnd(66, '1'),
      amount_paid: Amount.from(63),
      amount_issued: Amount.zero(),
      updated_at: null,
    } satisfies MintQuoteBolt12Response);

    expect(quote.amount?.equals(Amount.from(21))).toBe(true);
    expect(quote.quoteData.amount?.equals(Amount.from(21))).toBe(true);
    expect(getMintQuoteAmount(quote)).toBeUndefined();
  });
});
