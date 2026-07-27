import {
  Amount,
  type AmountLike,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
  type MintQuoteOnchainResponse as CashuMintQuoteOnchainResponse,
} from '@cashu/cashu-ts';
import { ProofValidationError } from './Error';
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
    return quote.amountPaid.subtract(quote.amountIssued);
  }

  return quote.state === 'PAID' ? quote.amount : Amount.zero();
}

export function isMintQuotePending(quote: MintQuote): boolean {
  if (isStatefulMintQuote(quote)) {
    return quote.state !== 'ISSUED';
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
  const now = options?.now ?? Date.now();
  const amount = Amount.from(quote.amount as unknown as AmountLike);
  const amountPaid = Amount.from(quote.amount_paid);
  const amountIssued = Amount.from(quote.amount_issued);

  assertValidMintQuoteAccounting(quote.quote, amountPaid, amountIssued);
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
    amountPaid,
    amountIssued,
    remoteUpdatedAt: quote.updated_at ?? null,
    quoteData: {
      amount,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function mintQuoteFromOnchainResponse(
  mintUrl: string,
  quote: CashuMintQuoteOnchainResponse,
  options?: { now?: number },
): MintQuote<'onchain'> {
  const now = options?.now ?? Date.now();
  const canonicalAmountPaid = Amount.from(quote.amount_paid);
  const canonicalAmountIssued = Amount.from(quote.amount_issued);
  assertValidMintQuoteAccounting(quote.quote, canonicalAmountPaid, canonicalAmountIssued);
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
    amountPaid: canonicalAmountPaid,
    amountIssued: canonicalAmountIssued,
    remoteUpdatedAt: quote.updated_at ?? null,
    quoteData: {
      pubkey: quote.pubkey,
    },
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
  const canonicalAmountPaid = Amount.from(quote.amount_paid);
  const canonicalAmountIssued = Amount.from(quote.amount_issued);
  assertValidMintQuoteAccounting(quote.quote, canonicalAmountPaid, canonicalAmountIssued);
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
    amountPaid: canonicalAmountPaid,
    amountIssued: canonicalAmountIssued,
    remoteUpdatedAt: quote.updated_at ?? null,
    quoteData: {
      pubkey: quote.pubkey,
      amount,
    },
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
      method: 'bolt11',
      amount: quote.amount,
      unit: quote.unit,
      expiry: quote.expiry,
      pubkey: quote.pubkey,
      state: quote.state,
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
