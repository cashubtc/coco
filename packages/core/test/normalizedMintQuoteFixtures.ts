import {
  Amount,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
  type MintQuoteOnchainResponse,
} from '@cashu/cashu-ts';
import {
  mintQuoteFromBolt11Response,
  mintQuoteFromBolt12Response,
  mintQuoteFromOnchainResponse,
  type MintQuote,
} from '../models/MintQuote.ts';
import type {
  CompatibleMintQuoteBolt11Response,
  CompatibleMintQuoteBolt12Response,
  CompatibleMintQuoteOnchainResponse,
} from '../operations/mint/MintMethodHandler.ts';

export function cashuNormalizedBolt11Fixture(
  quote: CompatibleMintQuoteBolt11Response,
): MintQuoteBolt11Response {
  const amount = Amount.from(quote.amount);
  const amountPaid =
    quote.amount_paid ??
    (quote.state === 'PAID' || quote.state === 'ISSUED' ? amount : Amount.zero());
  const amountIssued = quote.amount_issued ?? (quote.state === 'ISSUED' ? amount : Amount.zero());
  const state =
    quote.state ??
    (amountPaid.isZero() && amountIssued.isZero()
      ? 'UNPAID'
      : amountPaid.greaterThan(amountIssued)
        ? 'PAID'
        : 'ISSUED');

  return {
    ...quote,
    method: 'bolt11',
    amount,
    amount_paid: Amount.from(amountPaid),
    amount_issued: Amount.from(amountIssued),
    updated_at: quote.updated_at ?? null,
    state,
  };
}

export function cashuNormalizedBolt12Fixture(
  quote: CompatibleMintQuoteBolt12Response,
): MintQuoteBolt12Response {
  return {
    ...quote,
    method: 'bolt12',
    amount: quote.amount ?? null,
    updated_at: quote.updated_at ?? null,
  };
}

export function cashuNormalizedOnchainFixture(
  quote: CompatibleMintQuoteOnchainResponse,
): MintQuoteOnchainResponse {
  return {
    ...quote,
    method: 'onchain',
    updated_at: quote.updated_at ?? null,
  };
}

export function mintQuoteFromBolt11Fixture(
  mintUrl: string,
  quote: CompatibleMintQuoteBolt11Response,
): MintQuote<'bolt11'> {
  return mintQuoteFromBolt11Response(mintUrl, cashuNormalizedBolt11Fixture(quote));
}

export function mintQuoteFromBolt12Fixture(
  mintUrl: string,
  quote: CompatibleMintQuoteBolt12Response,
): MintQuote<'bolt12'> {
  return mintQuoteFromBolt12Response(mintUrl, cashuNormalizedBolt12Fixture(quote));
}

export function mintQuoteFromOnchainFixture(
  mintUrl: string,
  quote: CompatibleMintQuoteOnchainResponse,
): MintQuote<'onchain'> {
  return mintQuoteFromOnchainResponse(mintUrl, cashuNormalizedOnchainFixture(quote));
}
