import type { Amount, MeltQuoteBolt11Response, SerializedBlindedSignature } from '@cashu/cashu-ts';
import type {
  MeltMethod,
  MeltMethodQuoteSnapshot,
  MeltMethodRemoteState,
} from '../operations/melt/MeltMethodHandler';

export interface MeltQuote<M extends MeltMethod = MeltMethod> {
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
  fee_reserve: Amount;
  expiry: number;
  state: MeltMethodRemoteState<M>;
  payment_preimage?: string | null;
  change?: SerializedBlindedSignature[];
  lastObservedRemoteState?: MeltMethodRemoteState<M>;
  lastObservedRemoteStateAt?: number;
  createdAt: number;
  updatedAt: number;
}

export function meltQuoteFromBolt11Response(
  mintUrl: string,
  quote: MeltQuoteBolt11Response,
  options?: { now?: number },
): MeltQuote<'bolt11'> {
  const now = options?.now ?? Date.now();
  return {
    mintUrl,
    method: 'bolt11',
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
  };
}

export function meltQuoteToMethodSnapshot<M extends MeltMethod>(
  quote: MeltQuote<M>,
): MeltMethodQuoteSnapshot<M> {
  return {
    quote: quote.quoteId,
    request: quote.request,
    amount: quote.amount,
    unit: quote.unit,
    fee_reserve: quote.fee_reserve,
    expiry: quote.expiry,
    state: quote.state,
    payment_preimage: quote.payment_preimage ?? null,
    change: quote.change,
  } as MeltMethodQuoteSnapshot<M>;
}
