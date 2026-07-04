import { Amount, type AmountLike } from '@cashu/cashu-ts';
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
  amountPaid: Amount;
  amountIssued: Amount;
  remoteUpdatedAt: number | null;
  quoteData: MintMethodQuoteData<M>;
  createdAt: number;
  updatedAt: number;
}

export type Bolt11MintQuote = MintQuoteBase<'bolt11'> & {
  amount: Amount;
  /** @deprecated Use canonical amountPaid/amountIssued accounting instead. */
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
  if (!quote.amountPaid.greaterThan(quote.amountIssued)) return Amount.zero();
  return quote.amountPaid.subtract(quote.amountIssued);
}

export function getBolt11MintQuoteAccountingStatus(
  quote: Pick<MintQuote<'bolt11'>, 'amount' | 'amountPaid' | 'amountIssued'>,
): 'waiting' | 'ready' | 'completed' {
  if (!quote.amountIssued.lessThan(quote.amount)) {
    return 'completed';
  }

  const claimable = quote.amountPaid.greaterThan(quote.amountIssued)
    ? quote.amountPaid.subtract(quote.amountIssued)
    : Amount.zero();

  return claimable.lessThan(quote.amount) ? 'waiting' : 'ready';
}

export function isMintQuotePending(quote: MintQuote): boolean {
  if (isStatefulMintQuote(quote)) {
    return getBolt11MintQuoteAccountingStatus(quote) !== 'completed';
  }

  return true;
}

export function deriveMintQuoteAccountingFromState(
  state: MintMethodRemoteState<'bolt11'>,
  amount: Amount,
): { amountPaid: Amount; amountIssued: Amount } {
  if (state === 'UNPAID') {
    return { amountPaid: Amount.zero(), amountIssued: Amount.zero() };
  }

  if (state === 'PAID') {
    return { amountPaid: amount, amountIssued: Amount.zero() };
  }

  return { amountPaid: amount, amountIssued: amount };
}

export function deriveBolt11MintQuoteStateFromAccounting(
  amountPaid: Amount,
  amountIssued: Amount,
): MintMethodRemoteState<'bolt11'> {
  if (amountPaid.isZero() && amountIssued.isZero()) return 'UNPAID';
  if (amountPaid.greaterThan(amountIssued)) return 'PAID';
  return 'ISSUED';
}

export function assertValidMintQuoteAccounting(
  quoteId: string,
  amountPaid: Amount,
  amountIssued: Amount,
): void {
  if (amountIssued.greaterThan(amountPaid)) {
    throw new Error(
      `Mint quote ${quoteId} has invalid accounting: amountIssued exceeds amountPaid`,
    );
  }
}

export function mintQuoteFromBolt11Response(
  mintUrl: string,
  quote: MintMethodQuoteSnapshot<'bolt11'>,
  options?: { now?: number },
): MintQuote<'bolt11'> {
  const now = options?.now ?? Date.now();
  const amount = Amount.from(quote.amount as unknown as AmountLike);
  const amountPaid =
    quote.amount_paid !== undefined
      ? Amount.from(quote.amount_paid as unknown as AmountLike)
      : undefined;
  const amountIssued =
    quote.amount_issued !== undefined
      ? Amount.from(quote.amount_issued as unknown as AmountLike)
      : undefined;
  const accounting =
    amountPaid !== undefined && amountIssued !== undefined
      ? { amountPaid, amountIssued }
      : deriveMintQuoteAccountingFromState(quote.state ?? 'UNPAID', amount);
  const state =
    quote.state ??
    deriveBolt11MintQuoteStateFromAccounting(accounting.amountPaid, accounting.amountIssued);
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
    state,
    reusable: false,
    amountPaid: accounting.amountPaid,
    amountIssued: accounting.amountIssued,
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
  quote: MintMethodQuoteSnapshot<'onchain'>,
  options?: { now?: number },
): MintQuote<'onchain'> {
  const now = options?.now ?? Date.now();
  const amountPaid = quote.amount_paid ?? Amount.zero();
  const amountIssued = quote.amount_issued ?? Amount.zero();
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
    amountPaid: Amount.from(amountPaid),
    amountIssued: Amount.from(amountIssued),
    remoteUpdatedAt: quote.updated_at ?? null,
    quoteData: {
      pubkey: quote.pubkey,
      amountPaid: Amount.from(amountPaid),
      amountIssued: Amount.from(amountIssued),
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function mintQuoteFromBolt12Response(
  mintUrl: string,
  quote: MintMethodQuoteSnapshot<'bolt12'>,
  options?: { now?: number },
): MintQuote<'bolt12'> {
  const now = options?.now ?? Date.now();
  const amount = quote.amount ? Amount.from(quote.amount as unknown as AmountLike) : undefined;
  const amountPaid = quote.amount_paid ?? Amount.zero();
  const amountIssued = quote.amount_issued ?? Amount.zero();
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
    amountPaid: Amount.from(amountPaid),
    amountIssued: Amount.from(amountIssued),
    remoteUpdatedAt: quote.updated_at ?? null,
    quoteData: {
      pubkey: quote.pubkey,
      amount,
      amountPaid: Amount.from(amountPaid),
      amountIssued: Amount.from(amountIssued),
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
