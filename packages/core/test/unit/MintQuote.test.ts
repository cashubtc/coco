import {
  Amount,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
} from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';

import { MintQuoteValidationError } from '../../models/Error';
import {
  applyBolt11MintQuoteStateFallback,
  deriveBolt11MintQuoteState,
  getMintQuoteAvailableAmount,
  getMintQuoteAmount,
  getMintQuoteRemoteState,
  isBolt11MintQuoteIssued,
  isBolt11MintQuotePaid,
  isBolt11MintQuoteUnpaid,
  isMintQuotePending,
  mintQuoteFromBolt11Response,
  mintQuoteFromBolt12Response,
  mintQuoteToMethodSnapshot,
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

  it('uses BOLT11 accounting instead of the deprecated state projection', () => {
    const quote = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-accounting',
      request: 'lnbc...',
      method: 'bolt11',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: 123,
      state: 'UNPAID',
      amount_paid: Amount.from(100),
      amount_issued: Amount.from(40),
      updated_at: 55,
    } satisfies MintQuoteBolt11Response);

    expect(quote.state).toBe('PAID');
    expect(quote.amountPaid.equals(Amount.from(100))).toBe(true);
    expect(quote.amountIssued.equals(Amount.from(40))).toBe(true);
    expect(quote.remoteUpdatedAt).toBe(55);
    expect(getMintQuoteAvailableAmount(quote).equals(Amount.from(60))).toBe(true);
    expect(isMintQuotePending(quote)).toBe(true);
  });

  it('rejects contradictory BOLT11 accounting', () => {
    const createQuote = () =>
      mintQuoteFromBolt11Response('https://mint.test', {
        quote: 'quote-invalid-accounting',
        request: 'lnbc...',
        method: 'bolt11',
        amount: Amount.from(100),
        unit: 'sat',
        expiry: 123,
        state: 'PAID',
        amount_paid: Amount.from(100),
        amount_issued: Amount.from(101),
        updated_at: 55,
      } satisfies MintQuoteBolt11Response);

    expect(createQuote).toThrow(MintQuoteValidationError);
    expect(createQuote).toThrow('amount_issued greater than amount_paid');
  });

  it('uses canonical predicates for ready and terminal BOLT11 quotes', () => {
    const paid = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-paid',
      request: 'lnbc...',
      method: 'bolt11',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: 123,
      amount_paid: Amount.from(100),
      amount_issued: Amount.zero(),
      updated_at: 42,
      state: 'ISSUED',
    } satisfies MintQuoteBolt11Response);
    const issued = {
      ...paid,
      amountIssued: Amount.from(100),
      state: 'PAID' as const,
    };

    expect(deriveBolt11MintQuoteState(paid.amountPaid, paid.amountIssued)).toBe('PAID');
    expect(getMintQuoteRemoteState({ ...paid, state: 'ISSUED' })).toBe('PAID');
    expect(isBolt11MintQuoteUnpaid(paid)).toBe(false);
    expect(isBolt11MintQuotePaid(paid)).toBe(true);
    expect(isBolt11MintQuoteIssued(paid)).toBe(false);
    expect(mintQuoteToMethodSnapshot<'bolt11'>(paid).state).toBe('PAID');

    expect(getMintQuoteRemoteState(issued)).toBe('ISSUED');
    expect(isBolt11MintQuotePaid(issued)).toBe(false);
    expect(isBolt11MintQuoteIssued(issued)).toBe(true);
    expect(isMintQuotePending(issued)).toBe(false);
  });

  it('does not treat partial accounting as ready or terminal', () => {
    const partiallyPaid = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-partially-paid',
      request: 'lnbc...',
      method: 'bolt11',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: 123,
      amount_paid: Amount.from(50),
      amount_issued: Amount.zero(),
      updated_at: 44,
      state: 'PAID',
    } satisfies MintQuoteBolt11Response);
    const partiallyIssued = {
      ...partiallyPaid,
      amountIssued: Amount.from(50),
      state: 'ISSUED' as const,
    };

    expect(isBolt11MintQuotePaid(partiallyPaid)).toBe(false);
    expect(isMintQuotePending(partiallyPaid)).toBe(true);
    expect(isBolt11MintQuoteIssued(partiallyIssued)).toBe(false);
    expect(isMintQuotePending(partiallyIssued)).toBe(true);
  });

  it('does not let a legacy state replace ordered or partial accounting', () => {
    const ordered = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-ordered',
      request: 'lnbc...',
      method: 'bolt11',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: 123,
      amount_paid: Amount.from(50),
      amount_issued: Amount.zero(),
      updated_at: 44,
      state: 'PAID',
    } satisfies MintQuoteBolt11Response);
    const unordered = { ...ordered, remoteUpdatedAt: null };

    const orderedResult = applyBolt11MintQuoteStateFallback(ordered, 'ISSUED', 45);
    const unorderedResult = applyBolt11MintQuoteStateFallback(unordered, 'ISSUED', 45);

    expect(orderedResult.amountIssued.isZero()).toBe(true);
    expect(orderedResult.remoteUpdatedAt).toBe(44);
    expect(unorderedResult.amountPaid.equals(Amount.from(50))).toBe(true);
    expect(unorderedResult.amountIssued.isZero()).toBe(true);
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
