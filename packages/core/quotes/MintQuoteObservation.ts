import { isStatefulMintQuote, type MintQuote } from '../models/MintQuote';

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
    // Until #387, non-terminal BOLT11 state changes still alter canonical claimability.
    return !existing.amount.equals(incoming.amount) || existing.state !== incoming.state;
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
      resolvedQuote: existing ?? incoming,
      disposition: 'ignored-invalid-background',
    };
  }

  if (
    existing &&
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
    existing &&
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

  if (existing && (existing.remoteUpdatedAt === null || incoming.remoteUpdatedAt === null)) {
    const hasNewerAccounting = incoming.amountPaid
      .add(incoming.amountIssued)
      .greaterThan(existing.amountPaid.add(existing.amountIssued));
    const hasMonotonicComponents =
      !incoming.amountPaid.lessThan(existing.amountPaid) &&
      !incoming.amountIssued.lessThan(existing.amountIssued);
    if (!hasNewerAccounting || !hasMonotonicComponents) {
      return {
        resolvedQuote: existing,
        disposition: 'ignored-stale',
      };
    }
  }

  const resolvedQuote =
    existing && existing.remoteUpdatedAt !== null && incoming.remoteUpdatedAt === null
      ? { ...incoming, remoteUpdatedAt: existing.remoteUpdatedAt }
      : incoming;
  if (hasMeaningfulChange(existing, resolvedQuote)) {
    return { resolvedQuote, disposition: 'accepted-meaningful-change' };
  }
  if (existing?.remoteUpdatedAt === resolvedQuote.remoteUpdatedAt) {
    return { resolvedQuote: existing, disposition: 'ignored-unchanged' };
  }
  return { resolvedQuote, disposition: 'accepted-freshness-only' };
}
