import {
  Amount,
  type AmountLike,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
} from '@cashu/cashu-ts';
import type {
  MintMethod,
  MintMethodQuoteData,
  MintMethodQuoteSnapshot,
  MintMethodRemoteState,
} from '../operations/mint/MintMethodHandler';

/**
 * Current NUT-04 accounting fields are not present in cashu-ts 4.6.1's
 * BOLT11 response declaration, although the generic response normalizer keeps
 * them at runtime. Coco normalizes them here until the dependency type catches up.
 */
export type AccountingMintQuoteBolt11Response = MintQuoteBolt11Response & {
  amount_paid?: AmountLike;
  amount_issued?: AmountLike;
  updated_at?: number | bigint;
};

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

export function hasMintQuoteAccounting(quote: MintQuote<'bolt11'>): quote is MintQuote<'bolt11'> & {
  quoteData: MintQuote<'bolt11'>['quoteData'] & {
    amountPaid: Amount;
    amountIssued: Amount;
  };
} {
  return quote.quoteData.amountPaid !== undefined && quote.quoteData.amountIssued !== undefined;
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
  if (quote.method === 'bolt11' && hasMintQuoteAccounting(quote)) {
    return quote.quoteData.amountPaid.subtract(quote.quoteData.amountIssued);
  }

  if (quote.reusable) {
    return quote.quoteData.amountPaid.subtract(quote.quoteData.amountIssued);
  }

  return quote.state === 'PAID' ? quote.amount : Amount.zero();
}

export function isMintQuotePending(quote: MintQuote): boolean {
  if (isStatefulMintQuote(quote)) {
    if (hasMintQuoteAccounting(quote)) {
      return quote.quoteData.amountIssued.lessThan(quote.amount);
    }
    return quote.state !== 'ISSUED';
  }

  return true;
}

export function mintQuoteFromBolt11Response(
  mintUrl: string,
  quote: AccountingMintQuoteBolt11Response,
  options?: { now?: number },
): MintQuote<'bolt11'> {
  const now = options?.now ?? Date.now();
  const amount = Amount.from(quote.amount as unknown as AmountLike);
  const hasAmountPaid = quote.amount_paid !== undefined;
  const hasAmountIssued = quote.amount_issued !== undefined;
  if (hasAmountPaid !== hasAmountIssued) {
    throw new Error('BOLT11 mint quote accounting must include amount_paid and amount_issued');
  }

  const amountPaid = hasAmountPaid ? Amount.from(quote.amount_paid!) : undefined;
  const amountIssued = hasAmountIssued ? Amount.from(quote.amount_issued!) : undefined;
  if (amountPaid && amountIssued && amountIssued.greaterThan(amountPaid)) {
    throw new Error('BOLT11 mint quote amount_issued cannot exceed amount_paid');
  }

  const remoteUpdatedAt = normalizeRemoteUpdatedAt(quote.updated_at);
  const state = deriveBolt11MintQuoteState(amount, amountPaid, amountIssued, quote.state);
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
    lastObservedRemoteState: state,
    lastObservedRemoteStateAt: now,
    reusable: false,
    quoteData: {
      amount,
      ...(amountPaid !== undefined ? { amountPaid } : {}),
      ...(amountIssued !== undefined ? { amountIssued } : {}),
      ...(remoteUpdatedAt !== undefined ? { remoteUpdatedAt } : {}),
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
    return {
      quote: quote.quoteId,
      request: quote.request,
      amount: quote.amount,
      unit: quote.unit,
      expiry: quote.expiry,
      pubkey: quote.pubkey,
      state: quote.state,
      ...(quote.quoteData.amountPaid !== undefined
        ? { amount_paid: quote.quoteData.amountPaid }
        : {}),
      ...(quote.quoteData.amountIssued !== undefined
        ? { amount_issued: quote.quoteData.amountIssued }
        : {}),
      ...(quote.quoteData.remoteUpdatedAt !== undefined
        ? { updated_at: quote.quoteData.remoteUpdatedAt }
        : {}),
    } as MintMethodQuoteSnapshot<M>;
  }

  if (quote.method === 'onchain') {
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

  return {
    quote: quote.quoteId,
    request: quote.request,
    amount: quote.amount,
    unit: quote.unit,
    expiry: quote.expiry,
    pubkey: quote.quoteData.pubkey,
    amount_paid: quote.quoteData.amountPaid,
    amount_issued: quote.quoteData.amountIssued,
  } as MintMethodQuoteSnapshot<M>;
}

function deriveBolt11MintQuoteState(
  amount: Amount,
  amountPaid: Amount | undefined,
  amountIssued: Amount | undefined,
  legacyState: MintMethodRemoteState<'bolt11'>,
): MintMethodRemoteState<'bolt11'> {
  if (amountPaid === undefined || amountIssued === undefined) {
    return legacyState;
  }
  if (amountIssued.greaterThanOrEqual(amount)) {
    return 'ISSUED';
  }
  if (amountPaid.greaterThanOrEqual(amount)) {
    return 'PAID';
  }
  return 'UNPAID';
}

function normalizeRemoteUpdatedAt(value: number | bigint | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error('BOLT11 mint quote updated_at must be a non-negative safe integer');
  }
  return normalized;
}
