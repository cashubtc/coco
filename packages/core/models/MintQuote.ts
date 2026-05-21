import type { Amount, MintQuoteBolt11Response } from '@cashu/cashu-ts';
import type {
  MintMethod,
  MintMethodQuoteSnapshot,
  MintMethodRemoteState,
} from '../operations/mint/MintMethodHandler';

export interface MintQuote<M extends MintMethod = MintMethod> {
  mintUrl: string;
  method: M;
  quoteId: string;
  /**
   * Compatibility alias for cashu-ts BOLT11 quote snapshots.
   * New code should use quoteId for local/remote identity clarity.
   */
  quote: string;
  request: string;
  unit: string;
  amount: Amount;
  expiry: number | null;
  pubkey?: string;
  state: MintMethodRemoteState<M>;
  lastObservedRemoteState?: MintMethodRemoteState<M>;
  lastObservedRemoteStateAt?: number;
  reusable: boolean;
  createdAt: number;
  updatedAt: number;
}

export function mintQuoteFromBolt11Response(
  mintUrl: string,
  quote: MintQuoteBolt11Response,
  options?: { now?: number },
): MintQuote<'bolt11'> {
  const now = options?.now ?? Date.now();
  return {
    mintUrl,
    method: 'bolt11',
    quoteId: quote.quote,
    quote: quote.quote,
    request: quote.request,
    unit: quote.unit,
    amount: quote.amount,
    expiry: quote.expiry,
    pubkey: quote.pubkey,
    state: quote.state,
    lastObservedRemoteState: quote.state,
    lastObservedRemoteStateAt: now,
    reusable: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function mintQuoteToMethodSnapshot<M extends MintMethod>(
  quote: MintQuote<M>,
): MintMethodQuoteSnapshot<M> {
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
