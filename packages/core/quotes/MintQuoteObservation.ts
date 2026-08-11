import {
  deriveBolt11MintQuoteState,
  isStatefulMintQuote,
  type MintQuote,
} from '../models/MintQuote';

export type MintQuoteObservationDisposition =
  | 'accepted-meaningful-change'
  | 'accepted-freshness-only'
  | 'ignored-stale'
  | 'ignored-conflicting-accounting'
  | 'ignored-invalid-background'
  | 'ignored-unchanged';

export interface MintQuoteObservationResolution {
  resolvedQuote: MintQuote;
  disposition: MintQuoteObservationDisposition;
}

function withCanonicalCompatibilityProjection(quote: MintQuote): MintQuote {
  if (!isStatefulMintQuote(quote)) return quote;
  return {
    ...quote,
    state: deriveBolt11MintQuoteState(quote.amountPaid, quote.amountIssued),
  };
}

function hasAccountingComponentDecrease(existing: MintQuote, incoming: MintQuote): boolean {
  return (
    incoming.amountPaid.lessThan(existing.amountPaid) ||
    incoming.amountIssued.lessThan(existing.amountIssued)
  );
}

function hasMeaningfulChange(existing: MintQuote | null, incoming: MintQuote): boolean {
  if (!existing) return true;
  if (
    existing.method !== incoming.method ||
    existing.quoteId !== incoming.quoteId ||
    existing.request !== incoming.request ||
    existing.unit !== incoming.unit ||
    existing.expiry !== incoming.expiry ||
    (existing.pubkey ?? null) !== (incoming.pubkey ?? null) ||
    existing.reusable !== incoming.reusable ||
    !existing.amountPaid.equals(incoming.amountPaid) ||
    !existing.amountIssued.equals(incoming.amountIssued)
  ) {
    return true;
  }

  if (isStatefulMintQuote(existing) && isStatefulMintQuote(incoming)) {
    return !existing.amount.equals(incoming.amount);
  }

  if (existing.method === 'bolt12' && incoming.method === 'bolt12') {
    if (existing.amount === undefined || incoming.amount === undefined) {
      return existing.amount !== incoming.amount;
    }
    return !existing.amount.equals(incoming.amount);
  }

  return false;
}

/** Resolves one canonical Mint Quote Observation without performing lifecycle side effects. */
export function resolveMintQuoteObservation(
  existing: MintQuote | null,
  incoming: MintQuote,
): MintQuoteObservationResolution {
  if (incoming.amountIssued.greaterThan(incoming.amountPaid)) {
    return {
      resolvedQuote: existing ?? withCanonicalCompatibilityProjection(incoming),
      disposition: 'ignored-invalid-background',
    };
  }

  if (!existing || existing.method !== incoming.method || existing.quoteId !== incoming.quoteId) {
    return {
      resolvedQuote: withCanonicalCompatibilityProjection(incoming),
      disposition: 'accepted-meaningful-change',
    };
  }

  if (
    existing.remoteUpdatedAt !== null &&
    incoming.remoteUpdatedAt !== null &&
    incoming.remoteUpdatedAt < existing.remoteUpdatedAt
  ) {
    return {
      resolvedQuote: existing,
      disposition: 'ignored-stale',
    };
  }

  if (
    existing.remoteUpdatedAt !== null &&
    incoming.remoteUpdatedAt !== null &&
    incoming.remoteUpdatedAt === existing.remoteUpdatedAt &&
    (!incoming.amountPaid.equals(existing.amountPaid) ||
      !incoming.amountIssued.equals(existing.amountIssued))
  ) {
    return {
      resolvedQuote: existing,
      disposition: 'ignored-conflicting-accounting',
    };
  }

  // Once BOLT11 accounting has remote ordering, an unversioned compatibility observation
  // must not replace it. Legacy `state` remains a projection rather than an authority.
  if (
    isStatefulMintQuote(existing) &&
    isStatefulMintQuote(incoming) &&
    existing.remoteUpdatedAt !== null &&
    incoming.remoteUpdatedAt === null
  ) {
    return {
      resolvedQuote: existing,
      disposition: 'ignored-stale',
    };
  }

  if (hasAccountingComponentDecrease(existing, incoming)) {
    return {
      resolvedQuote: existing,
      disposition: 'ignored-stale',
    };
  }

  if (existing.remoteUpdatedAt === null || incoming.remoteUpdatedAt === null) {
    const hasNewerAccounting = incoming.amountPaid
      .add(incoming.amountIssued)
      .greaterThan(existing.amountPaid.add(existing.amountIssued));
    if (!hasNewerAccounting) {
      return {
        resolvedQuote: existing,
        disposition: 'ignored-stale',
      };
    }
  }

  const resolvedQuote = withCanonicalCompatibilityProjection(
    existing.remoteUpdatedAt !== null && incoming.remoteUpdatedAt === null
      ? { ...incoming, remoteUpdatedAt: existing.remoteUpdatedAt }
      : incoming,
  );
  if (hasMeaningfulChange(existing, resolvedQuote)) {
    return { resolvedQuote, disposition: 'accepted-meaningful-change' };
  }
  if (existing.remoteUpdatedAt === resolvedQuote.remoteUpdatedAt) {
    return { resolvedQuote: existing, disposition: 'ignored-unchanged' };
  }
  return { resolvedQuote, disposition: 'accepted-freshness-only' };
}
