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
  mintQuoteToMethodSnapshot,
  type GenericMintQuote,
  type MintQuote,
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

  it('projects generic mint quotes into generic method snapshots', () => {
    const quote: GenericMintQuote<'fedimint'> = {
      mintUrl: 'https://mint.test',
      method: 'fedimint',
      quoteId: 'generic-mint-quote',
      quote: 'generic-mint-quote',
      request: 'fedimint-request',
      unit: 'sat',
      expiry: null,
      reusable: true,
      quoteData: {
        pubkey: 'pubkey',
        amountPaid: Amount.from(100),
        amountIssued: Amount.from(40),
      },
      rawQuoteData: {
        route: 'federation-1',
      },
      createdAt: 0,
      updatedAt: 0,
    };

    const snapshot = mintQuoteToMethodSnapshot(quote);
    const quoteForBuiltInHelpers = quote as unknown as MintQuote;

    expect(snapshot.quote).toBe('generic-mint-quote');
    expect(snapshot.request).toBe('fedimint-request');
    expect(snapshot.unit).toBe('sat');
    expect(snapshot.pubkey).toBe('pubkey');
    expect(Amount.from(snapshot.amount_paid).equals(Amount.from(100))).toBe(true);
    expect(Amount.from(snapshot.amount_issued).equals(Amount.from(40))).toBe(true);
    expect(snapshot.route).toBe('federation-1');
    expect(getMintQuoteAvailableAmount(quoteForBuiltInHelpers).equals(Amount.from(60))).toBe(true);
    expect(isMintQuotePending(quoteForBuiltInHelpers)).toBe(true);
  });
});
