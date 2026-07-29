import {
  Amount,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
} from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';

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
    expect(quote.amountPaid.equals(Amount.from(100))).toBe(true);
    expect(quote.amountIssued.equals(Amount.from(40))).toBe(true);
    expect(quote.remoteUpdatedAt).toBe(55);
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
    ).toThrow();
    expect(() =>
      mintQuoteFromBolt11Response('https://mint.test', {
        ...base,
        amount_paid: 100,
        amount_issued: 101,
      } as unknown as MintQuoteBolt11Response),
    ).toThrow('amount_issued greater than amount_paid');
  });

  it('treats BOLT11 accounting as authoritative over the deprecated state projection', () => {
    const canonical = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-accounting-authority',
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
    const contradictoryProjection = {
      ...canonical,
      state: 'ISSUED' as const,
    };

    expect(canonical.state).toBe('PAID');
    expect(deriveBolt11MintQuoteState(canonical.amountPaid, canonical.amountIssued)).toBe('PAID');
    expect(getMintQuoteRemoteState(contradictoryProjection)).toBe('PAID');
    expect(isBolt11MintQuoteUnpaid(contradictoryProjection)).toBe(false);
    expect(isBolt11MintQuotePaid(contradictoryProjection)).toBe(true);
    expect(isBolt11MintQuoteIssued(contradictoryProjection)).toBe(false);
    expect(isMintQuotePending(contradictoryProjection)).toBe(true);
    expect(getMintQuoteAvailableAmount(contradictoryProjection).equals(Amount.from(100))).toBe(
      true,
    );
    expect(mintQuoteToMethodSnapshot<'bolt11'>(contradictoryProjection).state).toBe('PAID');
  });

  it('recognizes terminal BOLT11 issuance from accounting, not compatibility state', () => {
    const quote = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-accounting-terminal',
      request: 'lnbc...',
      method: 'bolt11',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: 123,
      amount_paid: Amount.from(100),
      amount_issued: Amount.from(100),
      updated_at: 43,
      state: 'PAID',
    } satisfies MintQuoteBolt11Response);

    expect(quote.state).toBe('ISSUED');
    expect(isBolt11MintQuoteIssued(quote)).toBe(true);
    expect(isMintQuotePending(quote)).toBe(false);
    expect(getMintQuoteAvailableAmount(quote).isZero()).toBe(true);
  });

  it('does not let a legacy state observation override remotely ordered accounting', () => {
    const quote = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-ordered-accounting',
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

    const retained = applyBolt11MintQuoteStateFallback(quote, 'ISSUED', 45);

    expect(retained.amountPaid.equals(Amount.from(50))).toBe(true);
    expect(retained.amountIssued.isZero()).toBe(true);
    expect(retained.state).toBe('PAID');
    expect(retained.remoteUpdatedAt).toBe(44);
  });

  it('does not let legacy state replace partial accounting without a remote order', () => {
    const quote = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-partial-unordered-accounting',
      request: 'lnbc...',
      method: 'bolt11',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: 123,
      amount_paid: Amount.from(50),
      amount_issued: Amount.zero(),
      updated_at: null,
      state: 'PAID',
    } satisfies MintQuoteBolt11Response);

    const retained = applyBolt11MintQuoteStateFallback(quote, 'ISSUED', 45);

    expect(retained.amountPaid.equals(Amount.from(50))).toBe(true);
    expect(retained.amountIssued.isZero()).toBe(true);
    expect(retained.state).toBe('PAID');
  });

  it('does not treat partial BOLT11 accounting projections as ready or terminal', () => {
    const partiallyPaid = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-partial-paid',
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
    const partiallyIssued = mintQuoteFromBolt11Response('https://mint.test', {
      quote: 'quote-partial-issued',
      request: 'lnbc...',
      method: 'bolt11',
      amount: Amount.from(100),
      unit: 'sat',
      expiry: 123,
      amount_paid: Amount.from(50),
      amount_issued: Amount.from(50),
      updated_at: 45,
      state: 'ISSUED',
    } satisfies MintQuoteBolt11Response);

    expect(partiallyPaid.state).toBe('PAID');
    expect(isBolt11MintQuotePaid(partiallyPaid)).toBe(false);
    expect(isMintQuotePending(partiallyPaid)).toBe(true);
    expect(partiallyIssued.state).toBe('ISSUED');
    expect(isBolt11MintQuoteIssued(partiallyIssued)).toBe(false);
    expect(isMintQuotePending(partiallyIssued)).toBe(true);
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
