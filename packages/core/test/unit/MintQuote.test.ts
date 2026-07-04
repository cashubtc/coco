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
    expect(quote.amountPaid.equals(Amount.from(100))).toBe(true);
    expect(quote.amountIssued.equals(Amount.zero())).toBe(true);
    expect(quote.remoteUpdatedAt).toBe(null);
    expect(quote.quoteData.amount.equals(Amount.from(100))).toBe(true);
  });

  it('derives deprecated BOLT11 state from accounting when state is omitted', () => {
    const unpaid = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-unpaid',
      request: 'lnbc...',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: 123,
      amount_paid: Amount.zero(),
      amount_issued: Amount.zero(),
      updated_at: 1_700_000_000,
    } as unknown as MintQuoteBolt11Response);
    const paid = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-paid',
      request: 'lnbc...',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: 123,
      amount_paid: Amount.from(100),
      amount_issued: Amount.from(40),
      updated_at: null,
    } as unknown as MintQuoteBolt11Response);
    const issued = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-issued',
      request: 'lnbc...',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: 123,
      amount_paid: Amount.from(100),
      amount_issued: Amount.from(100),
      updated_at: null,
    } as unknown as MintQuoteBolt11Response);

    expect(unpaid.state).toBe('UNPAID');
    expect(unpaid.remoteUpdatedAt).toBe(1_700_000_000);
    expect(paid.state).toBe('PAID');
    expect(issued.state).toBe('ISSUED');
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
    expect(quote.amountPaid.equals(Amount.from(63))).toBe(true);
    expect(quote.amountIssued.equals(Amount.zero())).toBe(true);
    expect(quote.quoteData.amount?.equals(Amount.from(21))).toBe(true);
    expect(getMintQuoteAmount(quote)).toBeUndefined();
  });
});
