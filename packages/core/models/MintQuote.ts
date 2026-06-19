import {
  Amount,
  type AmountLike,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
} from '@cashu/cashu-ts';
import type {
  BuiltInMintMethod,
  GenericMintMethod,
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

export type Bolt12MintQuote = MintQuoteBase<'bolt12'> & {
  amount?: Amount;
  state?: never;
  lastObservedRemoteState?: never;
  lastObservedRemoteStateAt?: number;
  reusable: true;
};

export type GenericMintQuote<M extends string = string> = MintQuoteBase<GenericMintMethod<M>> & {
  amount?: never;
  state?: never;
  lastObservedRemoteState?: never;
  lastObservedRemoteStateAt?: number;
  reusable: true;
  rawQuoteData?: Record<string, unknown>;
};

export type MintQuote<M extends MintMethod = BuiltInMintMethod> = M extends 'bolt11'
  ? Bolt11MintQuote
  : M extends 'onchain'
    ? OnchainMintQuote
    : M extends 'bolt12'
      ? Bolt12MintQuote
      : GenericMintQuote<Extract<M, string>>;

export function isStatefulMintQuote(quote: MintQuote): quote is MintQuote<'bolt11'> {
  return quote.method === 'bolt11';
}

export function getMintQuoteRemoteState(
  quote: MintQuote,
): MintMethodRemoteState<'bolt11'> | undefined {
  return isStatefulMintQuote(quote) ? quote.state : undefined;
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
  if (quote.reusable) {
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

export function mintQuoteFromBolt12Response(
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
    quoteData: {
      pubkey: quote.pubkey,
      amount,
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
    const bolt11Quote = quote as MintQuote<'bolt11'>;
    return {
      quote: bolt11Quote.quoteId,
      request: bolt11Quote.request,
      amount: bolt11Quote.amount,
      unit: bolt11Quote.unit,
      expiry: bolt11Quote.expiry,
      pubkey: bolt11Quote.pubkey,
      state: bolt11Quote.state,
    } as MintMethodQuoteSnapshot<M>;
  }

  if (quote.method === 'onchain') {
    const onchainQuote = quote as MintQuote<'onchain'>;
    return {
      quote: onchainQuote.quoteId,
      request: onchainQuote.request,
      unit: onchainQuote.unit,
      expiry: onchainQuote.expiry,
      pubkey: onchainQuote.quoteData.pubkey,
      amount_paid: onchainQuote.quoteData.amountPaid,
      amount_issued: onchainQuote.quoteData.amountIssued,
    } as MintMethodQuoteSnapshot<M>;
  }

  if (quote.method === 'bolt12') {
    const bolt12Quote = quote as MintQuote<'bolt12'>;
    return {
      quote: bolt12Quote.quoteId,
      request: bolt12Quote.request,
      amount: bolt12Quote.amount,
      unit: bolt12Quote.unit,
      expiry: bolt12Quote.expiry,
      pubkey: bolt12Quote.quoteData.pubkey,
      amount_paid: bolt12Quote.quoteData.amountPaid,
      amount_issued: bolt12Quote.quoteData.amountIssued,
    } as MintMethodQuoteSnapshot<M>;
  }

  const genericQuote = quote as GenericMintQuote;
  return {
    quote: genericQuote.quoteId,
    request: genericQuote.request,
    unit: genericQuote.unit,
    expiry: genericQuote.expiry,
    pubkey: genericQuote.quoteData.pubkey,
    amount_paid: genericQuote.quoteData.amountPaid,
    amount_issued: genericQuote.quoteData.amountIssued,
    ...(genericQuote.rawQuoteData ?? {}),
  } as MintMethodQuoteSnapshot<M>;
}
