import {
  Amount,
  type AmountLike,
  type MeltQuoteBolt11Response,
  type MeltQuoteBolt12Response,
  type MeltQuoteOnchainFeeOption,
  type MeltQuoteOnchainResponse,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts';
import type {
  BuiltInMeltMethod,
  GenericMeltMethod,
  MeltMethod,
  MeltMethodQuoteSnapshot,
  MeltMethodRemoteState,
} from '../operations/melt/MeltMethodHandler';

type BoltMeltMethod = 'bolt11' | 'bolt12';

interface MeltQuoteBase<M extends MeltMethod> {
  mintUrl: string;
  method: M;
  quoteId: string;
  /**
   * Compatibility alias for cashu-ts BOLT11 quote snapshots.
   * New code should use quoteId for local/remote identity clarity.
   */
  quote: string;
  request: string;
  amount: Amount;
  unit: string;
  expiry: number;
  state: MeltMethodRemoteState<M>;
  change?: SerializedBlindedSignature[];
  lastObservedRemoteState?: MeltMethodRemoteState<M>;
  lastObservedRemoteStateAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface BoltMeltQuote<M extends BoltMeltMethod = BoltMeltMethod> extends MeltQuoteBase<M> {
  fee_reserve: Amount;
  payment_preimage?: string | null;
}

export interface OnchainMeltQuote extends MeltQuoteBase<'onchain'> {
  fee_options: MeltQuoteOnchainFeeOption[];
  outpoint?: string;
}

export interface GenericMeltQuote<M extends string = string> extends MeltQuoteBase<
  GenericMeltMethod<M>
> {
  fee_reserve: Amount;
  payment_preimage?: string | null;
  rawQuoteData?: Record<string, unknown>;
}

export type MeltQuote<M extends MeltMethod = BuiltInMeltMethod> = M extends 'onchain'
  ? OnchainMeltQuote
  : M extends BoltMeltMethod
    ? BoltMeltQuote<M>
    : GenericMeltQuote<Extract<M, string>>;

type BoltMeltQuoteResponse = MeltQuoteBolt11Response | MeltQuoteBolt12Response;

function meltQuoteFromBoltResponse<M extends BoltMeltMethod>(
  mintUrl: string,
  method: M,
  quote: BoltMeltQuoteResponse,
  options?: { now?: number },
): MeltQuote<M> {
  const now = options?.now ?? Date.now();
  return {
    mintUrl,
    method,
    quoteId: quote.quote,
    quote: quote.quote,
    request: quote.request,
    amount: quote.amount,
    unit: quote.unit,
    fee_reserve: quote.fee_reserve,
    expiry: quote.expiry,
    state: quote.state,
    payment_preimage: quote.payment_preimage,
    change: quote.change,
    lastObservedRemoteState: quote.state,
    lastObservedRemoteStateAt: now,
    createdAt: now,
    updatedAt: now,
  } as MeltQuote<M>;
}

export function meltQuoteFromBolt11Response(
  mintUrl: string,
  quote: MeltQuoteBolt11Response,
  options?: { now?: number },
): MeltQuote<'bolt11'> {
  return meltQuoteFromBoltResponse(mintUrl, 'bolt11', quote, options);
}

export function meltQuoteFromBolt12Response(
  mintUrl: string,
  quote: MeltQuoteBolt12Response,
  options?: { now?: number },
): MeltQuote<'bolt12'> {
  return meltQuoteFromBoltResponse(mintUrl, 'bolt12', quote, options);
}

export function meltQuoteFromOnchainResponse(
  mintUrl: string,
  quote: MeltQuoteOnchainResponse,
  options?: { now?: number },
): MeltQuote<'onchain'> {
  const now = options?.now ?? Date.now();
  const feeOptions = normalizeOnchainFeeOptions(quote.quote, quote.fee_options);
  return {
    mintUrl,
    method: 'onchain',
    quoteId: quote.quote,
    quote: quote.quote,
    request: quote.request,
    amount: quote.amount,
    unit: quote.unit,
    fee_options: feeOptions,
    expiry: quote.expiry,
    state: quote.state,
    outpoint: quote.outpoint ?? undefined,
    change: quote.change,
    lastObservedRemoteState: quote.state,
    lastObservedRemoteStateAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

export function meltQuoteToMethodSnapshot<M extends MeltMethod>(
  quote: MeltQuote<M>,
): MeltMethodQuoteSnapshot<M> {
  if (quote.method === 'onchain') {
    const onchainQuote = quote as MeltQuote<'onchain'>;
    return {
      quote: onchainQuote.quoteId,
      request: onchainQuote.request,
      amount: onchainQuote.amount,
      unit: onchainQuote.unit,
      fee_options: onchainQuote.fee_options,
      selected_fee_index: null,
      outpoint: onchainQuote.outpoint ?? null,
      expiry: onchainQuote.expiry,
      state: onchainQuote.state,
      change: onchainQuote.change,
    } as MeltMethodQuoteSnapshot<M>;
  }

  if (quote.method === 'bolt11' || quote.method === 'bolt12') {
    const boltQuote = quote as BoltMeltQuote;
    return {
      quote: boltQuote.quoteId,
      request: boltQuote.request,
      amount: boltQuote.amount,
      unit: boltQuote.unit,
      fee_reserve: boltQuote.fee_reserve,
      expiry: boltQuote.expiry,
      state: boltQuote.state,
      payment_preimage: boltQuote.payment_preimage ?? null,
      change: boltQuote.change,
    } as MeltMethodQuoteSnapshot<M>;
  }

  const genericQuote = quote as GenericMeltQuote;
  return {
    quote: genericQuote.quoteId,
    request: genericQuote.request,
    amount: genericQuote.amount,
    unit: genericQuote.unit,
    fee_reserve: genericQuote.fee_reserve,
    expiry: genericQuote.expiry,
    state: genericQuote.state,
    payment_preimage: genericQuote.payment_preimage ?? null,
    change: genericQuote.change,
    ...(genericQuote.rawQuoteData ?? {}),
  } as MeltMethodQuoteSnapshot<M>;
}

export function resolveOnchainMeltFeeOption(
  quote: MeltQuote<'onchain'>,
  feeIndex?: number,
): { feeIndex: number; feeOption: MeltQuoteOnchainFeeOption } {
  const feeOptions = quote.fee_options;
  if (feeOptions.length === 0) {
    throw new Error(`Melt quote ${quote.quoteId} has no onchain fee options`);
  }

  if (feeIndex === undefined) {
    throw new Error(`Melt quote ${quote.quoteId} requires an explicit feeIndex`);
  }

  const feeOption = feeOptions.find((option) => option.fee_index === feeIndex);
  if (!feeOption) {
    throw new Error(`Melt quote ${quote.quoteId} does not include onchain fee option ${feeIndex}`);
  }

  return { feeIndex, feeOption };
}

function normalizeOnchainFeeOptions(
  quoteId: string,
  feeOptions: MeltQuoteOnchainFeeOption[] | undefined,
): MeltQuoteOnchainFeeOption[] {
  if (!feeOptions || feeOptions.length === 0) {
    throw new Error(`Onchain melt quote ${quoteId} did not include fee_options`);
  }

  const seen = new Set<number>();
  return feeOptions.map((option) => {
    if (!Number.isFinite(option.fee_index) || !Number.isInteger(option.fee_index)) {
      throw new Error(`Onchain melt quote ${quoteId} has invalid fee_index`);
    }
    if (seen.has(option.fee_index)) {
      throw new Error(`Onchain melt quote ${quoteId} has duplicate fee_index ${option.fee_index}`);
    }
    seen.add(option.fee_index);

    if (
      !Number.isFinite(option.estimated_blocks) ||
      !Number.isInteger(option.estimated_blocks) ||
      option.estimated_blocks < 0
    ) {
      throw new Error(`Onchain melt quote ${quoteId} has invalid estimated_blocks`);
    }

    return {
      fee_index: option.fee_index,
      fee_reserve: Amount.from(option.fee_reserve as AmountLike),
      estimated_blocks: option.estimated_blocks,
    };
  });
}
