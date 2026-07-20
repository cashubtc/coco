import {
  Amount,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
} from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';

import {
  getMintQuoteAvailableAmount,
  getMintQuoteAmount,
  isMintQuotePending,
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
  });

  it('uses current BOLT11 accounting instead of deprecated state', () => {
    const quote = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-accounting',
      request: 'lnbc...',
      amount: 100,
      unit: 'sat',
      expiry: 123,
      state: 'UNPAID',
      amount_paid: 100,
      amount_issued: 40,
      updated_at: 55,
    } as unknown as MintQuoteBolt11Response);

    expect(quote.state).toBe('PAID');
    expect(quote.quoteData.amountPaid?.equals(Amount.from(100))).toBe(true);
    expect(quote.quoteData.amountIssued?.equals(Amount.from(40))).toBe(true);
    expect(quote.quoteData.remoteUpdatedAt).toBe(55);
    expect(getMintQuoteAvailableAmount(quote).equals(Amount.from(60))).toBe(true);
    expect(isMintQuotePending(quote)).toBe(true);
  });

  it('rejects incomplete or contradictory BOLT11 accounting', () => {
    const base = {
      quote: 'quote-invalid-accounting',
      request: 'lnbc...',
      amount: 100,
      unit: 'sat',
      expiry: 123,
      state: 'PAID' as const,
    };

    expect(() =>
      mintQuoteFromBolt11Response('https://mint.test', {
        ...base,
        amount_paid: 100,
      } as unknown as MintQuoteBolt11Response),
    ).toThrow('must include amount_paid and amount_issued');
    expect(() =>
      mintQuoteFromBolt11Response('https://mint.test', {
        ...base,
        amount_paid: 100,
        amount_issued: 101,
      } as unknown as MintQuoteBolt11Response),
    ).toThrow('amount_issued cannot exceed amount_paid');
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
