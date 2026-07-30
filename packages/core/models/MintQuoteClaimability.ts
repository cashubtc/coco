import { Amount } from '@cashu/cashu-ts';

import type { MintQuote } from './MintQuote.ts';

export type MintQuoteClaimabilityStatus = 'waiting' | 'claimable' | 'complete' | 'invalid';

export interface MintQuoteClaimabilityAssessment {
  status: MintQuoteClaimabilityStatus;
  remoteAvailable: Amount;
  claimAmount?: Amount;
}

export interface MintQuoteClaimabilityFacts {
  finalizedAmount?: Amount;
  reservedAmount?: Amount;
  requestedAmount?: Amount;
}

function invalid(remoteAvailable: Amount): MintQuoteClaimabilityAssessment {
  return { status: 'invalid', remoteAvailable };
}

function waiting(remoteAvailable: Amount): MintQuoteClaimabilityAssessment {
  return { status: 'waiting', remoteAvailable };
}

function assessAtomicClaimability(
  quote: MintQuote<'bolt11'>,
  facts: MintQuoteClaimabilityFacts,
  remoteAvailable: Amount,
): MintQuoteClaimabilityAssessment {
  if (
    (!quote.amountIssued.isZero() && !quote.amountIssued.equals(quote.amount)) ||
    (facts.requestedAmount !== undefined && !facts.requestedAmount.equals(quote.amount))
  ) {
    return invalid(remoteAvailable);
  }

  if (
    quote.amountIssued.equals(quote.amount) ||
    facts.finalizedAmount?.greaterThanOrEqual(quote.amount)
  ) {
    return { status: 'complete', remoteAvailable };
  }

  if (quote.amountPaid.lessThan(quote.amount)) {
    return waiting(remoteAvailable);
  }

  return {
    status: 'claimable',
    remoteAvailable,
    claimAmount: quote.amount,
  };
}

function assessBalanceClaimability(
  quote: MintQuote<'bolt12' | 'onchain'>,
  facts: MintQuoteClaimabilityFacts,
  remoteAvailable: Amount,
): MintQuoteClaimabilityAssessment {
  const finalizedAmount = facts.finalizedAmount ?? Amount.zero();
  const effectiveIssued = finalizedAmount.greaterThan(quote.amountIssued)
    ? finalizedAmount
    : quote.amountIssued;
  const availableAfterFinalized = quote.amountPaid.lessThan(effectiveIssued)
    ? Amount.zero()
    : quote.amountPaid.subtract(effectiveIssued);
  const reservedAmount = facts.reservedAmount ?? Amount.zero();
  const locallyAvailable = availableAfterFinalized.lessThan(reservedAmount)
    ? Amount.zero()
    : availableAfterFinalized.subtract(reservedAmount);
  const claimAmount = facts.requestedAmount ?? locallyAvailable;

  if (claimAmount.isZero() || claimAmount.greaterThan(locallyAvailable)) {
    return waiting(remoteAvailable);
  }

  return { status: 'claimable', remoteAvailable, claimAmount };
}

/**
 * Assesses canonical Mint Quote Accounting for one local claim.
 *
 * Quote expiry and deprecated BOLT11 compatibility state are deliberately absent from the facts
 * consumed by this module. Atomic-versus-balance policy is private to this implementation.
 */
export function assessMintQuoteClaimability(
  quote: MintQuote,
  facts: MintQuoteClaimabilityFacts = {},
): MintQuoteClaimabilityAssessment {
  if (quote.amountIssued.greaterThan(quote.amountPaid)) {
    return invalid(Amount.zero());
  }

  const remoteAvailable = quote.amountPaid.subtract(quote.amountIssued);
  if (facts.requestedAmount?.isZero()) {
    return invalid(remoteAvailable);
  }

  if (quote.method === 'bolt11') {
    return assessAtomicClaimability(quote, facts, remoteAvailable);
  }

  return assessBalanceClaimability(quote, facts, remoteAvailable);
}
