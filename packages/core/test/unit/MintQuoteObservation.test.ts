import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { resolveMintQuoteObservation } from '../../quotes/MintQuoteObservation';
import {
  mintQuoteFromBolt11Fixture,
  mintQuoteFromBolt12Fixture,
  mintQuoteFromOnchainFixture,
} from '../normalizedMintQuoteFixtures';

describe('resolveMintQuoteObservation', () => {
  const mintUrl = 'https://mint.test';
  const expiry = Math.floor(Date.now() / 1000) + 3600;

  it('treats a compatibility-only BOLT11 state transition as freshness-only', () => {
    const existing = mintQuoteFromBolt11Fixture(mintUrl, {
      quote: 'bolt11-state-change',
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry,
      state: 'PAID',
      updated_at: 20,
    });
    const incoming = {
      ...existing,
      state: 'ISSUED' as const,
      remoteUpdatedAt: 21,
    };

    const resolution = resolveMintQuoteObservation(existing, incoming);

    expect(resolution.disposition).toBe('accepted-freshness-only');
    expect(resolution.resolvedQuote.state).toBe('PAID');
    expect(resolution.resolvedQuote.remoteUpdatedAt).toBe(21);
  });

  it('ignores BOLT11 observations older than the stored remote update', () => {
    const existing = mintQuoteFromBolt11Fixture(mintUrl, {
      quote: 'bolt11-stale',
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry,
      amount_paid: Amount.from(10),
      amount_issued: Amount.zero(),
      updated_at: 20,
    });
    const incoming = {
      ...existing,
      amountIssued: Amount.from(10),
      remoteUpdatedAt: 19,
    };

    const resolution = resolveMintQuoteObservation(existing, incoming);

    expect(resolution.disposition).toBe('ignored-stale');
    expect(resolution.resolvedQuote).toBe(existing);
  });

  it('ignores conflicting accounting at the same remote update', () => {
    const existing = mintQuoteFromBolt11Fixture(mintUrl, {
      quote: 'bolt11-conflict',
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry,
      amount_paid: Amount.from(10),
      amount_issued: Amount.zero(),
      updated_at: 20,
    });
    const incoming = {
      ...existing,
      amountIssued: Amount.from(5),
    };

    const resolution = resolveMintQuoteObservation(existing, incoming);

    expect(resolution.disposition).toBe('ignored-conflicting-accounting');
    expect(resolution.resolvedQuote).toBe(existing);
  });

  it('ignores accounting component regressions even with a newer update', () => {
    const existing = mintQuoteFromBolt11Fixture(mintUrl, {
      quote: 'bolt11-regression',
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry,
      amount_paid: Amount.from(10),
      amount_issued: Amount.from(5),
      updated_at: 20,
    });
    const incoming = {
      ...existing,
      amountIssued: Amount.zero(),
      remoteUpdatedAt: 21,
    };

    const resolution = resolveMintQuoteObservation(existing, incoming);

    expect(resolution.disposition).toBe('ignored-stale');
    expect(resolution.resolvedQuote).toBe(existing);
  });

  it('accepts monotonic accounting at a newer remote update', () => {
    const existing = mintQuoteFromBolt11Fixture(mintUrl, {
      quote: 'bolt11-forward',
      request: 'lnbc1test',
      amount: Amount.from(10),
      unit: 'sat',
      expiry,
      amount_paid: Amount.from(10),
      amount_issued: Amount.zero(),
      updated_at: 20,
    });
    const incoming = {
      ...existing,
      amountIssued: Amount.from(10),
      remoteUpdatedAt: 21,
      state: 'UNPAID' as const,
    };

    const resolution = resolveMintQuoteObservation(existing, incoming);

    expect(resolution.disposition).toBe('accepted-meaningful-change');
    expect(resolution.resolvedQuote.state).toBe('ISSUED');
    expect(resolution.resolvedQuote.amountIssued.equals(Amount.from(10))).toBe(true);
  });

  it('classifies freshness-only changes for amountless BOLT12 quotes', () => {
    const existing = mintQuoteFromBolt12Fixture(mintUrl, {
      quote: 'bolt12-freshness',
      request: 'lno1test',
      method: 'bolt12',
      amount: null,
      unit: 'sat',
      expiry,
      pubkey: '02'.padEnd(66, '1'),
      amount_paid: Amount.zero(),
      amount_issued: Amount.zero(),
      updated_at: 20,
    });
    const incoming = { ...existing, remoteUpdatedAt: 21 };

    const resolution = resolveMintQuoteObservation(existing, incoming);

    expect(resolution.disposition).toBe('accepted-freshness-only');
    expect(resolution.resolvedQuote).toBe(incoming);
  });

  it('classifies BOLT12 amount changes as meaningful', () => {
    const existing = mintQuoteFromBolt12Fixture(mintUrl, {
      quote: 'bolt12-amount-change',
      request: 'lno1test',
      method: 'bolt12',
      amount: Amount.from(10),
      unit: 'sat',
      expiry,
      pubkey: '02'.padEnd(66, '2'),
      amount_paid: Amount.zero(),
      amount_issued: Amount.zero(),
      updated_at: 20,
    });
    const amount = Amount.from(20);
    const incoming = {
      ...existing,
      amount,
      quoteData: { ...existing.quoteData, amount },
      remoteUpdatedAt: 21,
    };

    const resolution = resolveMintQuoteObservation(existing, incoming);

    expect(resolution.disposition).toBe('accepted-meaningful-change');
    expect(resolution.resolvedQuote).toBe(incoming);
  });

  it('ignores an unchanged observation at the same freshness timestamp', () => {
    const existing = mintQuoteFromOnchainFixture(mintUrl, {
      quote: 'onchain-unchanged',
      request: 'bc1qtest',
      method: 'onchain',
      unit: 'sat',
      expiry,
      pubkey: '02'.padEnd(66, '3'),
      amount_paid: Amount.from(10),
      amount_issued: Amount.from(2),
      updated_at: 20,
    });
    const incoming = { ...existing };

    const resolution = resolveMintQuoteObservation(existing, incoming);

    expect(resolution.disposition).toBe('ignored-unchanged');
    expect(resolution.resolvedQuote).toBe(existing);
  });
});
