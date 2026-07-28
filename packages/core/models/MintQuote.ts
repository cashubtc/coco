import {
  Amount,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
  type MintQuoteOnchainResponse as CashuMintQuoteOnchainResponse,
} from '@cashu/cashu-ts';
import { ProofValidationError } from './Error';
import {
  mintQuoteObservationFromBolt11Response,
  mintQuoteObservationFromBolt12Response,
  mintQuoteObservationFromOnchainResponse,
} from './MintQuoteObservationFactory';
import type {
  MintMethod,
  MintMethodQuoteData,
  MintMethodQuoteSnapshot,
  MintMethodRemoteState,
} from '../operations/mint/MintMethodHandler';

export type MintQuoteOnchainResponse = CashuMintQuoteOnchainResponse;

interface MintQuoteBase<M extends MintMethod> {
  mintUrl: string;
  method: M;
  quoteId: string;
  /**
   * Compatibility alias for cashu-ts quote snapshots.
   * New code should use quoteId for local/remote identity clarity.
   */
  quote: string;
  request: string;
  unit: string;
  expiry: number | null;
  pubkey?: string;
  reusable: boolean;
  /** Mint-reported cumulative amount paid toward this quote. */
  amountPaid: Amount;
  /** Mint-reported cumulative amount issued from this quote. */
  amountIssued: Amount;
  /**
   * Mint-reported Remote Quote Update Time in protocol seconds, or `null` when unavailable.
   * This is distinct from Coco's local `updatedAt` timestamp in milliseconds.
   */
  remoteUpdatedAt: number | null;
  quoteData: MintMethodQuoteData<M>;
  createdAt: number;
  updatedAt: number;
}

export type Bolt11MintQuote = MintQuoteBase<'bolt11'> & {
  amount: Amount;
  /**
   * @deprecated Use `amountPaid` and `amountIssued` for Mint Quote Accounting.
   */
  state: MintMethodRemoteState<'bolt11'>;
  reusable: false;
};

export type OnchainMintQuote = MintQuoteBase<'onchain'> & {
  amount?: never;
  state?: never;
  reusable: true;
};

export type Bolt12MintQuote = MintQuoteBase<'bolt12'> & {
  amount?: Amount;
  state?: never;
  reusable: true;
};

export type MintQuote<M extends MintMethod = MintMethod> = M extends 'bolt11'
  ? Bolt11MintQuote
  : M extends 'onchain'
    ? OnchainMintQuote
    : M extends 'bolt12'
      ? Bolt12MintQuote
      : never;

export function isStatefulMintQuote(quote: MintQuote): quote is MintQuote<'bolt11'> {
  return quote.method === 'bolt11';
}

/** Derives the deprecated BOLT11 state projection from canonical quote accounting. */
export function deriveBolt11MintQuoteState(
  amountPaid: Amount,
  amountIssued: Amount,
): MintMethodRemoteState<'bolt11'> {
  return amountPaid.isZero() && amountIssued.isZero()
    ? 'UNPAID'
    : amountPaid.greaterThan(amountIssued)
      ? 'PAID'
      : 'ISSUED';
}

/** Returns whether canonical BOLT11 accounting represents an unpaid quote. */
export function isBolt11MintQuoteUnpaid(quote: MintQuote<'bolt11'>): boolean {
  return quote.amountPaid.isZero() && quote.amountIssued.isZero();
}

/** Returns whether canonical BOLT11 accounting can fund the quote's exact mint operation. */
export function isBolt11MintQuotePaid(quote: MintQuote<'bolt11'>): boolean {
  return (
    quote.amountIssued.isZero() &&
    quote.amountPaid.greaterThanOrEqual(quote.amount) &&
    getMintQuoteAvailableAmount(quote).greaterThanOrEqual(quote.amount)
  );
}

/** Returns whether canonical BOLT11 accounting has issued the quote's full fixed amount. */
export function isBolt11MintQuoteIssued(quote: MintQuote<'bolt11'>): boolean {
  return quote.amountIssued.greaterThanOrEqual(quote.amount);
}

/**
 * Applies a legacy BOLT11 state observation without allowing it to reduce canonical accounting.
 *
 * @deprecated Legacy state is a fallback for snapshots that do not carry Mint Quote Accounting.
 */
export function applyBolt11MintQuoteStateFallback(
  quote: MintQuote<'bolt11'>,
  state: MintMethodRemoteState<'bolt11'>,
  observedAt = Date.now(),
): MintQuote<'bolt11'> {
  const hasLegacyProjectionShape =
    (quote.amountPaid.isZero() && quote.amountIssued.isZero()) ||
    (quote.amountPaid.equals(quote.amount) && quote.amountIssued.isZero()) ||
    (quote.amountPaid.equals(quote.amount) && quote.amountIssued.equals(quote.amount));
  if (quote.remoteUpdatedAt !== null || !hasLegacyProjectionShape) {
    return {
      ...quote,
      state: deriveBolt11MintQuoteState(quote.amountPaid, quote.amountIssued),
      updatedAt: observedAt,
    };
  }

  const paidFallback = state === 'UNPAID' ? Amount.zero() : quote.amount;
  const issuedFallback = state === 'ISSUED' ? quote.amount : Amount.zero();
  const amountPaid = quote.amountPaid.greaterThan(paidFallback) ? quote.amountPaid : paidFallback;
  const amountIssued = quote.amountIssued.greaterThan(issuedFallback)
    ? quote.amountIssued
    : issuedFallback;

  return {
    ...quote,
    state: deriveBolt11MintQuoteState(amountPaid, amountIssued),
    amountPaid,
    amountIssued,
    updatedAt: observedAt,
  };
}

/**
 * Returns the deprecated BOLT11 state projection for compatibility consumers.
 *
 * @deprecated Use `amountPaid` and `amountIssued`, or the canonical accounting predicates.
 */
export function getMintQuoteRemoteState(
  quote: MintQuote,
): MintMethodRemoteState<'bolt11'> | undefined {
  return isStatefulMintQuote(quote)
    ? deriveBolt11MintQuoteState(quote.amountPaid, quote.amountIssued)
    : undefined;
}

/**
 * Returns the fixed mint operation amount for stateful quotes.
 *
 * Reusable quote metadata may include a payment amount, such as a fixed BOLT12
 * offer amount, but that does not constrain the later mint operation amount.
 */
export function getMintQuoteAmount(quote: MintQuote): Amount | undefined {
  if (isStatefulMintQuote(quote)) {
    return quote.amount;
  }

  return undefined;
}

export function getMintQuoteAvailableAmount(quote: MintQuote): Amount {
  return quote.amountPaid.subtract(quote.amountIssued);
}

export function isMintQuotePending(quote: MintQuote): boolean {
  if (isStatefulMintQuote(quote)) {
    return !isBolt11MintQuoteIssued(quote);
  }

  return true;
}

function assertValidMintQuoteAccounting(
  quoteId: string,
  amountPaid: Amount,
  amountIssued: Amount,
): void {
  if (amountIssued.greaterThan(amountPaid)) {
    throw new ProofValidationError(
      `Mint quote ${quoteId} has amount_issued greater than amount_paid`,
    );
  }
}

export function mintQuoteFromBolt11Response(
  mintUrl: string,
  quote: MintQuoteBolt11Response,
  options?: { now?: number },
): MintQuote<'bolt11'> {
  const observation = mintQuoteObservationFromBolt11Response(mintUrl, quote, options);
  const canonicalQuote: MintQuote<'bolt11'> = {
    ...observation,
    state: deriveBolt11MintQuoteState(observation.amountPaid, observation.amountIssued),
  };
  assertValidMintQuoteAccounting(
    canonicalQuote.quoteId,
    canonicalQuote.amountPaid,
    canonicalQuote.amountIssued,
  );
  return canonicalQuote;
}

export function mintQuoteFromOnchainResponse(
  mintUrl: string,
  quote: CashuMintQuoteOnchainResponse,
  options?: { now?: number },
): MintQuote<'onchain'> {
  const canonicalQuote = mintQuoteObservationFromOnchainResponse(mintUrl, quote, options);
  assertValidMintQuoteAccounting(
    canonicalQuote.quoteId,
    canonicalQuote.amountPaid,
    canonicalQuote.amountIssued,
  );
  return canonicalQuote;
}

export function mintQuoteFromBolt12Response(
  mintUrl: string,
  quote: MintQuoteBolt12Response,
  options?: { now?: number },
): MintQuote<'bolt12'> {
  const canonicalQuote = mintQuoteObservationFromBolt12Response(mintUrl, quote, options);
  assertValidMintQuoteAccounting(
    canonicalQuote.quoteId,
    canonicalQuote.amountPaid,
    canonicalQuote.amountIssued,
  );
  return canonicalQuote;
}

export function mintQuoteToMethodSnapshot<M extends MintMethod>(
  quote: MintQuote<M>,
): MintMethodQuoteSnapshot<M> {
  if (quote.method === 'bolt11') {
    return {
      quote: quote.quoteId,
      request: quote.request,
      method: 'bolt11',
      amount: quote.amount,
      unit: quote.unit,
      expiry: quote.expiry,
      pubkey: quote.pubkey,
      state: deriveBolt11MintQuoteState(quote.amountPaid, quote.amountIssued),
      amount_paid: quote.amountPaid,
      amount_issued: quote.amountIssued,
      updated_at: quote.remoteUpdatedAt,
    } as MintMethodQuoteSnapshot<M>;
  }

  if (quote.method === 'onchain') {
    return {
      quote: quote.quoteId,
      request: quote.request,
      method: 'onchain',
      unit: quote.unit,
      expiry: quote.expiry,
      pubkey: quote.quoteData.pubkey,
      amount_paid: quote.amountPaid,
      amount_issued: quote.amountIssued,
      updated_at: quote.remoteUpdatedAt,
    } as MintMethodQuoteSnapshot<M>;
  }

  return {
    quote: quote.quoteId,
    request: quote.request,
    method: 'bolt12',
    amount: quote.amount,
    unit: quote.unit,
    expiry: quote.expiry,
    pubkey: quote.quoteData.pubkey,
    amount_paid: quote.amountPaid,
    amount_issued: quote.amountIssued,
    updated_at: quote.remoteUpdatedAt,
  } as MintMethodQuoteSnapshot<M>;
}
