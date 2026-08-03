import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';

import type { MintQuote } from '../../models/MintQuote.ts';
import { assessMintQuoteClaimability } from '../../models/MintQuoteClaimability.ts';

const mintUrl = 'https://mint.test';
const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

function makeBolt11Quote(expiry: number | null = futureExpiry): MintQuote<'bolt11'> {
  const amount = Amount.from(10);
  return {
    mintUrl,
    method: 'bolt11',
    quoteId: 'bolt11-quote',
    quote: 'bolt11-quote',
    request: 'lnbc1test',
    amount,
    unit: 'sat',
    expiry,
    state: 'ISSUED',
    reusable: false,
    amountPaid: Amount.zero(),
    amountIssued: Amount.zero(),
    remoteUpdatedAt: null,
    quoteData: { amount },
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeBalanceQuote(
  method: 'bolt12' | 'onchain',
  expiry: number | null = futureExpiry,
): MintQuote<'bolt12' | 'onchain'> {
  return {
    mintUrl,
    method,
    quoteId: `${method}-quote`,
    quote: `${method}-quote`,
    request: method === 'bolt12' ? 'lno1test' : 'bc1qtest',
    unit: 'sat',
    expiry,
    reusable: true,
    amountPaid: Amount.zero(),
    amountIssued: Amount.zero(),
    remoteUpdatedAt: null,
    quoteData: { pubkey: '02'.padEnd(66, '1') },
    createdAt: 1,
    updatedAt: 1,
  } as MintQuote<'bolt12' | 'onchain'>;
}

describe('assessMintQuoteClaimability', () => {
  it.each([
    ['bolt11', makeBolt11Quote()],
    ['bolt12', makeBalanceQuote('bolt12')],
    ['onchain', makeBalanceQuote('onchain')],
  ] as const)('classifies zero %s accounting as waiting', (_method, quote) => {
    const assessment = assessMintQuoteClaimability(quote);

    expect(assessment.status).toBe('waiting');
    expect(assessment.remoteAvailable.equals(Amount.zero())).toBe(true);
    expect(assessment.claimAmount).toBeUndefined();
  });

  it.each([
    ['bolt11', makeBolt11Quote],
    ['bolt12', (expiry: number | null) => makeBalanceQuote('bolt12', expiry)],
    ['onchain', (expiry: number | null) => makeBalanceQuote('onchain', expiry)],
  ] as const)('ignores %s expiry for identical accounting', (_method, makeQuote) => {
    const beforeExpiry = {
      ...makeQuote(futureExpiry),
      amountPaid: Amount.from(10),
    } as MintQuote;
    const afterExpiry = {
      ...makeQuote(1),
      amountPaid: Amount.from(10),
    } as MintQuote;

    const before = assessMintQuoteClaimability(beforeExpiry);
    const after = assessMintQuoteClaimability(afterExpiry);

    expect(after.status).toBe(before.status);
    expect(after.remoteAvailable.equals(before.remoteAvailable)).toBe(true);
    expect(after.claimAmount?.equals(before.claimAmount ?? Amount.zero())).toBe(true);
  });

  it.each([
    ['bolt11', { ...makeBolt11Quote(), amountPaid: Amount.from(10) }],
    ['bolt12', { ...makeBalanceQuote('bolt12'), amountPaid: Amount.from(10) }],
    ['onchain', { ...makeBalanceQuote('onchain'), amountPaid: Amount.from(10) }],
  ] as const)('classifies a zero %s claim request as invalid', (_method, quote) => {
    const assessment = assessMintQuoteClaimability(quote as MintQuote, {
      requestedAmount: Amount.zero(),
    });

    expect(assessment.status).toBe('invalid');
    expect(assessment.claimAmount).toBeUndefined();
  });

  it.each([
    ['bolt11', makeBolt11Quote()],
    ['bolt12', makeBalanceQuote('bolt12')],
    ['onchain', makeBalanceQuote('onchain')],
  ] as const)('classifies paid, unissued %s accounting as claimable', (_method, quote) => {
    const paidQuote = { ...quote, amountPaid: Amount.from(10) } as MintQuote;

    const assessment = assessMintQuoteClaimability(paidQuote);

    expect(assessment.status).toBe('claimable');
    expect(assessment.remoteAvailable.equals(Amount.from(10))).toBe(true);
    expect(assessment.claimAmount?.equals(Amount.from(10))).toBe(true);
  });

  it('keeps a partially paid BOLT11 quote waiting for its full fixed amount', () => {
    const quote = {
      ...makeBolt11Quote(),
      amountPaid: Amount.from(9),
      state: 'PAID' as const,
    };

    const assessment = assessMintQuoteClaimability(quote);

    expect(assessment.status).toBe('waiting');
    expect(assessment.remoteAvailable.equals(Amount.from(9))).toBe(true);
    expect(assessment.claimAmount).toBeUndefined();
  });

  it('classifies a fully issued BOLT11 quote as complete', () => {
    const quote = {
      ...makeBolt11Quote(),
      amountPaid: Amount.from(10),
      amountIssued: Amount.from(10),
      state: 'UNPAID' as const,
    };

    const assessment = assessMintQuoteClaimability(quote);

    expect(assessment.status).toBe('complete');
    expect(assessment.remoteAvailable.equals(Amount.zero())).toBe(true);
    expect(assessment.claimAmount).toBeUndefined();
  });

  it.each(['bolt12', 'onchain'] as const)(
    'accounts for finalized local %s operations while remote issuance lags',
    (method) => {
      const quote = {
        ...makeBalanceQuote(method),
        amountPaid: Amount.from(20),
        amountIssued: Amount.from(5),
      } as MintQuote<'bolt12' | 'onchain'>;

      const assessment = assessMintQuoteClaimability(quote, {
        finalizedAmount: Amount.from(12),
      });

      expect(assessment.status).toBe('claimable');
      expect(assessment.remoteAvailable.equals(Amount.from(15))).toBe(true);
      expect(assessment.claimAmount?.equals(Amount.from(8))).toBe(true);
    },
  );

  it.each(['bolt12', 'onchain'] as const)(
    'subtracts in-flight %s Mint Quote Reservations from the claim amount',
    (method) => {
      const quote = {
        ...makeBalanceQuote(method),
        amountPaid: Amount.from(20),
        amountIssued: Amount.from(5),
      } as MintQuote<'bolt12' | 'onchain'>;

      const assessment = assessMintQuoteClaimability(quote, {
        reservedAmount: Amount.from(6),
      });

      expect(assessment.status).toBe('claimable');
      expect(assessment.remoteAvailable.equals(Amount.from(15))).toBe(true);
      expect(assessment.claimAmount?.equals(Amount.from(9))).toBe(true);
    },
  );

  it('returns the requested balance claim when local availability is sufficient', () => {
    const quote = {
      ...makeBalanceQuote('onchain'),
      amountPaid: Amount.from(20),
      amountIssued: Amount.from(5),
    } as MintQuote<'onchain'>;

    const assessment = assessMintQuoteClaimability(quote, {
      requestedAmount: Amount.from(7),
    });

    expect(assessment.status).toBe('claimable');
    expect(assessment.remoteAvailable.equals(Amount.from(15))).toBe(true);
    expect(assessment.claimAmount?.equals(Amount.from(7))).toBe(true);
  });

  it.each(['bolt12', 'onchain'] as const)(
    'keeps a %s request waiting when the local balance is insufficient',
    (method) => {
      const quote = {
        ...makeBalanceQuote(method),
        amountPaid: Amount.from(10),
        amountIssued: Amount.from(4),
      } as MintQuote<'bolt12' | 'onchain'>;

      const assessment = assessMintQuoteClaimability(quote, {
        reservedAmount: Amount.from(2),
        requestedAmount: Amount.from(5),
      });

      expect(assessment.status).toBe('waiting');
      expect(assessment.remoteAvailable.equals(Amount.from(6))).toBe(true);
      expect(assessment.claimAmount).toBeUndefined();
    },
  );

  it.each(['bolt12', 'onchain'] as const)(
    'keeps a fully drawn %s balance waiting for future funding',
    (method) => {
      const quote = {
        ...makeBalanceQuote(method),
        amountPaid: Amount.from(10),
        amountIssued: Amount.from(10),
      } as MintQuote<'bolt12' | 'onchain'>;

      const assessment = assessMintQuoteClaimability(quote);

      expect(assessment.status).toBe('waiting');
      expect(assessment.remoteAvailable.equals(Amount.zero())).toBe(true);
      expect(assessment.claimAmount).toBeUndefined();
    },
  );

  it('classifies a non-fixed BOLT11 claim request as invalid', () => {
    const quote = { ...makeBolt11Quote(), amountPaid: Amount.from(10) };

    const assessment = assessMintQuoteClaimability(quote, {
      requestedAmount: Amount.from(9),
      finalizedAmount: Amount.from(10),
      reservedAmount: Amount.from(10),
    });

    expect(assessment.status).toBe('invalid');
    expect(assessment.remoteAvailable.equals(Amount.from(10))).toBe(true);
    expect(assessment.claimAmount).toBeUndefined();
  });

  it('does not apply balance reservation arithmetic to an atomic BOLT11 claim', () => {
    const amount = Amount.from(10);
    const quote = { ...makeBolt11Quote(), amountPaid: amount };

    const assessment = assessMintQuoteClaimability(quote, {
      requestedAmount: amount,
      reservedAmount: amount,
    });

    expect(assessment.status).toBe('claimable');
    expect(assessment.remoteAvailable.equals(amount)).toBe(true);
    expect(assessment.claimAmount?.equals(amount)).toBe(true);
  });

  it('treats a full finalized local BOLT11 operation as complete while remote issuance lags', () => {
    const amount = Amount.from(10);
    const quote = { ...makeBolt11Quote(), amountPaid: Amount.from(11) };

    const assessment = assessMintQuoteClaimability(quote, {
      finalizedAmount: amount,
      reservedAmount: amount,
    });

    expect(assessment.status).toBe('complete');
    expect(assessment.remoteAvailable.equals(Amount.from(11))).toBe(true);
    expect(assessment.claimAmount).toBeUndefined();
  });

  it.each([
    ['bolt11', makeBolt11Quote()],
    ['bolt12', makeBalanceQuote('bolt12')],
    ['onchain', makeBalanceQuote('onchain')],
  ] as const)('classifies contradictory %s accounting as invalid', (_method, quote) => {
    const contradictory = {
      ...quote,
      amountPaid: Amount.from(5),
      amountIssued: Amount.from(6),
    } as MintQuote;

    const assessment = assessMintQuoteClaimability(contradictory);

    expect(assessment.status).toBe('invalid');
    expect(assessment.remoteAvailable.equals(Amount.zero())).toBe(true);
    expect(assessment.claimAmount).toBeUndefined();
  });

  it('classifies partial atomic issuance as invalid', () => {
    const quote = {
      ...makeBolt11Quote(),
      amountPaid: Amount.from(10),
      amountIssued: Amount.from(5),
    };

    const assessment = assessMintQuoteClaimability(quote);

    expect(assessment.status).toBe('invalid');
    expect(assessment.claimAmount).toBeUndefined();
  });

  it('claims exactly the fixed BOLT11 amount when remote payment exceeds it', () => {
    const amount = Amount.from(10);
    const quote = {
      ...makeBolt11Quote(),
      amountPaid: Amount.from(11),
    };

    const assessment = assessMintQuoteClaimability(quote);

    expect(assessment.status).toBe('claimable');
    expect(assessment.remoteAvailable.equals(Amount.from(11))).toBe(true);
    expect(assessment.claimAmount?.equals(amount)).toBe(true);
  });

  it('treats an overpaid BOLT11 quote as complete after its fixed amount is issued', () => {
    const amount = Amount.from(10);
    const quote = {
      ...makeBolt11Quote(),
      amountPaid: Amount.from(11),
      amountIssued: amount,
    };

    const assessment = assessMintQuoteClaimability(quote);

    expect(assessment.status).toBe('complete');
    expect(assessment.remoteAvailable.equals(Amount.from(1))).toBe(true);
    expect(assessment.claimAmount).toBeUndefined();
  });
});
