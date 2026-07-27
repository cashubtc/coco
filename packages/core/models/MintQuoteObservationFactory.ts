import {
  Amount,
  type AmountLike,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
  type MintQuoteOnchainResponse,
} from '@cashu/cashu-ts';
import type { MintQuote } from './MintQuote';

/** Maps a normalized BOLT11 response without enforcing canonical accounting invariants. */
export function mintQuoteObservationFromBolt11Response(
  mintUrl: string,
  quote: MintQuoteBolt11Response,
  options?: { now?: number },
): MintQuote<'bolt11'> {
  const now = options?.now ?? Date.now();
  const amount = Amount.from(quote.amount as unknown as AmountLike);
  return {
    mintUrl,
    method: 'bolt11',
    quoteId: quote.quote,
    quote: quote.quote,
    request: quote.request,
    unit: quote.unit,
    amount,
    expiry: quote.expiry,
    pubkey: quote.pubkey,
    state: quote.state,
    reusable: false,
    amountPaid: Amount.from(quote.amount_paid),
    amountIssued: Amount.from(quote.amount_issued),
    remoteUpdatedAt: quote.updated_at ?? null,
    quoteData: { amount },
    createdAt: now,
    updatedAt: now,
  };
}

/** Maps a normalized on-chain response without enforcing canonical accounting invariants. */
export function mintQuoteObservationFromOnchainResponse(
  mintUrl: string,
  quote: MintQuoteOnchainResponse,
  options?: { now?: number },
): MintQuote<'onchain'> {
  const now = options?.now ?? Date.now();
  return {
    mintUrl,
    method: 'onchain',
    quoteId: quote.quote,
    quote: quote.quote,
    request: quote.request,
    unit: quote.unit,
    expiry: quote.expiry,
    pubkey: quote.pubkey,
    reusable: true,
    amountPaid: Amount.from(quote.amount_paid),
    amountIssued: Amount.from(quote.amount_issued),
    remoteUpdatedAt: quote.updated_at ?? null,
    quoteData: { pubkey: quote.pubkey },
    createdAt: now,
    updatedAt: now,
  };
}

/** Maps a normalized BOLT12 response without enforcing canonical accounting invariants. */
export function mintQuoteObservationFromBolt12Response(
  mintUrl: string,
  quote: MintQuoteBolt12Response,
  options?: { now?: number },
): MintQuote<'bolt12'> {
  const now = options?.now ?? Date.now();
  const amount = quote.amount ? Amount.from(quote.amount as unknown as AmountLike) : undefined;
  return {
    mintUrl,
    method: 'bolt12',
    quoteId: quote.quote,
    quote: quote.quote,
    request: quote.request,
    unit: quote.unit,
    amount,
    expiry: quote.expiry,
    pubkey: quote.pubkey,
    reusable: true,
    amountPaid: Amount.from(quote.amount_paid),
    amountIssued: Amount.from(quote.amount_issued),
    remoteUpdatedAt: quote.updated_at ?? null,
    quoteData: { pubkey: quote.pubkey, amount },
    createdAt: now,
    updatedAt: now,
  };
}
