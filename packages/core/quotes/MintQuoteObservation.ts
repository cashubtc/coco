import type { Amount } from '@cashu/cashu-ts';
import { isStatefulMintQuote, type MintQuote } from '../models/MintQuote';

const MINT_QUOTE_STATE_RANK: Record<string, number> = {
  UNPAID: 0,
  PAID: 1,
  ISSUED: 2,
};

export type MintQuoteObservationPersistence = 'persist' | 'retain';
export type MintQuoteObservationMeaningfulChange = 'changed' | 'unchanged';

export interface MintQuoteObservationResolution {
  resolvedQuote: MintQuote;
  persistence: MintQuoteObservationPersistence;
  meaningfulChange: MintQuoteObservationMeaningfulChange;
}

function isMintQuoteStateDowngrade(existing: MintQuote, incoming: MintQuote): boolean {
  if (!isStatefulMintQuote(existing) || !isStatefulMintQuote(incoming)) return false;
  return (
    (MINT_QUOTE_STATE_RANK[incoming.state] ?? 0) < (MINT_QUOTE_STATE_RANK[existing.state] ?? 0)
  );
}

function maxAmount(left: Amount, right: Amount): Amount {
  return left.greaterThan(right) ? left : right;
}

function mergeReusableSettlement(existing: MintQuote, incoming: MintQuote): MintQuote {
  if (!existing.reusable || !incoming.reusable) return incoming;

  return {
    ...incoming,
    quoteData: {
      ...incoming.quoteData,
      amountPaid: maxAmount(existing.quoteData.amountPaid, incoming.quoteData.amountPaid),
      amountIssued: maxAmount(existing.quoteData.amountIssued, incoming.quoteData.amountIssued),
    },
  } as MintQuote;
}

function hasMeaningfulChange(existing: MintQuote | null, incoming: MintQuote): boolean {
  if (!existing) return true;
  if (existing.method !== incoming.method || existing.quoteId !== incoming.quoteId) return true;

  if (isStatefulMintQuote(existing) && isStatefulMintQuote(incoming)) {
    return existing.state !== incoming.state;
  }

  if (existing.reusable && incoming.reusable) {
    return (
      !existing.quoteData.amountPaid.equals(incoming.quoteData.amountPaid) ||
      !existing.quoteData.amountIssued.equals(incoming.quoteData.amountIssued)
    );
  }

  return false;
}

/** Resolves one canonical Mint Quote Observation without performing lifecycle side effects. */
export function resolveMintQuoteObservation(
  existing: MintQuote | null,
  incoming: MintQuote,
): MintQuoteObservationResolution {
  if (existing && isMintQuoteStateDowngrade(existing, incoming)) {
    return {
      resolvedQuote: existing,
      persistence: 'retain',
      meaningfulChange: 'unchanged',
    };
  }

  const resolvedQuote = existing ? mergeReusableSettlement(existing, incoming) : incoming;
  return {
    resolvedQuote,
    persistence: 'persist',
    meaningfulChange: hasMeaningfulChange(existing, resolvedQuote) ? 'changed' : 'unchanged',
  };
}
