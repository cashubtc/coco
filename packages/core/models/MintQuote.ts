import { Amount, type AmountLike, type MintQuoteBolt11Response } from '@cashu/cashu-ts';
import type {
  MintMethod,
  MintMethodQuoteData,
  MintMethodQuoteSnapshot,
  MintMethodRemoteState,
} from '../operations/mint/MintMethodHandler';

export type MintQuoteOnchainResponse = MintMethodQuoteSnapshot<'onchain'>;

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
  quoteData: MintMethodQuoteData<M>;
  createdAt: number;
  updatedAt: number;
}

export type Bolt11MintQuote = MintQuoteBase<'bolt11'> & {
  amount: Amount;
  state: MintMethodRemoteState<'bolt11'>;
  lastObservedRemoteState?: MintMethodRemoteState<'bolt11'>;
  lastObservedRemoteStateAt?: number;
  reusable: false;
};

export type OnchainMintQuote = MintQuoteBase<'onchain'> & {
  amount?: never;
  state?: never;
  lastObservedRemoteState?: never;
  lastObservedRemoteStateAt?: number;
  reusable: true;
};

export type MintQuote<M extends MintMethod = MintMethod> = M extends 'bolt11'
  ? Bolt11MintQuote
  : M extends 'onchain'
    ? OnchainMintQuote
    : never;

export function isStatefulMintQuote(quote: MintQuote): quote is MintQuote<'bolt11'> {
  return quote.method === 'bolt11';
}

export function getMintQuoteRemoteState(
  quote: MintQuote,
): MintMethodRemoteState<'bolt11'> | undefined {
  return isStatefulMintQuote(quote) ? quote.state : undefined;
}

export function getMintQuoteAmount(quote: MintQuote): Amount | undefined {
  return isStatefulMintQuote(quote) ? quote.amount : undefined;
}

export function getMintQuoteAvailableAmount(quote: MintQuote): Amount {
  if (quote.method === 'onchain') {
    return quote.quoteData.amountPaid.subtract(quote.quoteData.amountIssued);
  }

  return quote.state === 'PAID' ? quote.amount : Amount.zero();
}

export function isMintQuotePending(quote: MintQuote): boolean {
  if (isStatefulMintQuote(quote)) {
    return quote.state !== 'ISSUED';
  }

  return true;
}

export function mintQuoteFromBolt11Response(
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
    lastObservedRemoteState: quote.state,
    lastObservedRemoteStateAt: now,
    reusable: false,
    quoteData: {
      amount,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function mintQuoteFromOnchainResponse(
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
    quoteData: {
      pubkey: quote.pubkey,
      amountPaid: Amount.from(quote.amount_paid),
      amountIssued: Amount.from(quote.amount_issued),
    },
    lastObservedRemoteStateAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

export function mintQuoteToMethodSnapshot<M extends MintMethod>(
  quote: MintQuote<M>,
): MintMethodQuoteSnapshot<M> {
  if (quote.method === 'bolt11') {
    return {
      quote: quote.quoteId,
      request: quote.request,
      amount: quote.amount,
      unit: quote.unit,
      expiry: quote.expiry,
      pubkey: quote.pubkey,
      state: quote.state,
    } as MintMethodQuoteSnapshot<M>;
  }

  return {
    quote: quote.quoteId,
    request: quote.request,
    unit: quote.unit,
    expiry: quote.expiry,
    pubkey: quote.quoteData.pubkey,
    amount_paid: quote.quoteData.amountPaid,
    amount_issued: quote.quoteData.amountIssued,
  } as MintMethodQuoteSnapshot<M>;
}
