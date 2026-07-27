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
  it('normalizes JSON mint quote amounts into Amount instances', () => {
    const quote = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-1',
      request: 'lnbc...',
      amount: 100,
      unit: 'sat',
      expiry: 123,
      state: 'PAID',
    } as unknown as MintQuoteBolt11Response);

    expect(quote.amount.equals(Amount.from(100))).toBe(true);
    expect(quote.quoteData.amount.equals(Amount.from(100))).toBe(true);
    expect(quote.amountPaid.equals(Amount.from(100))).toBe(true);
    expect(quote.amountIssued.equals(Amount.zero())).toBe(true);
    expect(quote.remoteUpdatedAt).toBe(null);
  });

  it('derives the deprecated BOLT11 state from canonical accounting', () => {
    const cases = [
      { amountPaid: 0, amountIssued: 0, state: 'UNPAID' },
      { amountPaid: 100, amountIssued: 0, state: 'PAID' },
      { amountPaid: 100, amountIssued: 100, state: 'ISSUED' },
    ] as const;

    for (const testCase of cases) {
      const quote = mintQuoteFromBolt11Response('https://mint.test', {
        quote: `quote-${testCase.state.toLowerCase()}`,
        request: 'lnbc...',
        amount: 100,
        unit: 'sat',
        expiry: 123,
        amount_paid: testCase.amountPaid,
        amount_issued: testCase.amountIssued,
        updated_at: 456,
      } as unknown as MintQuoteBolt11Response);

      expect(quote.state).toBe(testCase.state);
      expect(quote.amountPaid.equals(Amount.from(testCase.amountPaid))).toBe(true);
      expect(quote.amountIssued.equals(Amount.from(testCase.amountIssued))).toBe(true);
      expect(quote.remoteUpdatedAt).toBe(456);
    }
  });

  it('keeps BOLT12 offer amounts separate from mint operation amounts', () => {
    const quote = mintQuoteFromBolt12Response('https://mint.test', {
      quote: 'quote-1',
      request: 'lno1...',
      amount: Amount.from(21),
      unit: 'sat',
      expiry: 123,
      pubkey: '02'.padEnd(66, '1'),
      amount_paid: Amount.from(63),
      amount_issued: Amount.zero(),
    } as unknown as MintQuoteBolt12Response);

    expect(quote.amount?.equals(Amount.from(21))).toBe(true);
    expect(quote.quoteData.amount?.equals(Amount.from(21))).toBe(true);
    expect(getMintQuoteAmount(quote)).toBeUndefined();
  });
});
