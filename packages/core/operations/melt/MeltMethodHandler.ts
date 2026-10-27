import {
  Amount,
  type AmountLike,
  type MeltQuoteBaseResponse,
  type MeltQuoteBolt11Response,
  type MeltQuoteBolt12Response,
  type MeltQuoteOnchainResponse,
  type Wallet,
  type Proof,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts';
import type { Logger } from '../../logging/Logger';
import type { ExecutingMeltOperation, MeltMethodFinalizedData } from './MeltOperation';
import type { MintAdapter } from '@core/infra';
import type { MeltQuote } from '../../models/MeltQuote';

/**
 * Registry of supported melt methods and their public input payload shapes.
 * Extend via declaration merging if you need to add methods externally.
 */
export interface MeltMethodInputDefinitions {
  bolt11: { invoice: string; amountSats?: AmountLike };
  bolt12: { offer: string; amountSats?: AmountLike };
  onchain: { address: string; amountSats: AmountLike };
}

/**
 * Registry of supported melt methods and their normalized operation payload shapes.
 * Amount values are normalized at the operation boundary.
 */
export interface MeltMethodDefinitions {
  bolt11: { invoice: string; amountSats?: Amount };
  bolt12: { offer: string; amountSats?: Amount };
  onchain: { address: string; amountSats: Amount; feeIndex?: number };
}

export type MeltMethod = keyof MeltMethodDefinitions;

export type MeltMethodData<M extends MeltMethod = MeltMethod> = MeltMethodDefinitions[M];

type OptionalMethodMeltQuote<T extends MeltQuoteBaseResponse> = Omit<T, 'method'> &
  Partial<Pick<MeltQuoteBaseResponse, 'method'>>;

/** Accept v4 caller snapshots while cashu-ts v5 owns normalization of live mint responses. */
export type CompatibleMeltQuoteBolt11Response = OptionalMethodMeltQuote<MeltQuoteBolt11Response>;
export type CompatibleMeltQuoteBolt12Response = OptionalMethodMeltQuote<MeltQuoteBolt12Response>;
export type CompatibleMeltQuoteOnchainResponse = OptionalMethodMeltQuote<MeltQuoteOnchainResponse>;

export interface MeltMethodQuoteDefinitions {
  bolt11: CompatibleMeltQuoteBolt11Response;
  bolt12: CompatibleMeltQuoteBolt12Response;
  onchain: CompatibleMeltQuoteOnchainResponse;
}

export type MeltMethodInputData<M extends MeltMethod = MeltMethod> =
  M extends keyof MeltMethodInputDefinitions ? MeltMethodInputDefinitions[M] : never;

export type MeltMethodRemoteState<M extends MeltMethod = MeltMethod> =
  MeltMethodQuoteDefinitions[M]['state'];

export type MeltMethodQuoteSnapshot<M extends MeltMethod = MeltMethod> =
  MeltMethodQuoteDefinitions[M];

export interface MeltMethodMeta<M extends MeltMethod = MeltMethod> {
  method: M;
  methodData: MeltMethodData<M>;
}

export function normalizeMeltMethodData<M extends MeltMethod>(
  methodData: MeltMethodInputData<M> | MeltMethodData<M>,
): MeltMethodData<M> {
  if (
    typeof methodData !== 'object' ||
    methodData === null ||
    !('amountSats' in methodData) ||
    methodData.amountSats === undefined
  ) {
    return methodData as MeltMethodData<M>;
  }

  return {
    ...methodData,
    amountSats: Amount.from(methodData.amountSats as AmountLike),
  } as MeltMethodData<M>;
}

// ---------------------------------------------------------------------------
// Contexts / Results
// ---------------------------------------------------------------------------

export interface MeltRemoteDeps {
  mintAdapter: MintAdapter;
  logger?: Logger;
}

export interface CreateMeltQuoteContext<M extends MeltMethod = MeltMethod> extends MeltRemoteDeps {
  mintUrl: string;
  methodData: MeltMethodData<M>;
  unit: string;
  wallet: Wallet;
}

export interface FetchRemoteMeltQuoteContext<
  M extends MeltMethod = MeltMethod,
> extends MeltRemoteDeps {
  quote: MeltQuote<M>;
}

export interface SwapMeltContext<M extends MeltMethod = MeltMethod> {
  operation: ExecutingMeltOperation & MeltMethodMeta<M>;
  wallet: Wallet;
  inputProofs: Proof[];
  logger?: Logger;
}

export interface ExecuteMeltContext<M extends MeltMethod = MeltMethod> extends MeltRemoteDeps {
  operation: ExecutingMeltOperation & MeltMethodMeta<M>;
  inputProofs: Proof[];
}

export interface MeltRemoteResult<M extends MeltMethod = MeltMethod> {
  status: MeltMethodRemoteState<M>;
  change?: SerializedBlindedSignature[];
  finalizedData?: MeltMethodFinalizedData<M>;
}

export type PendingCheckResult = 'finalize' | 'stay_pending' | 'rollback';

export interface MeltMethodHandler<M extends MeltMethod = MeltMethod> {
  createQuote(ctx: CreateMeltQuoteContext<M>): Promise<MeltQuote<M>>;
  fetchRemoteQuote(ctx: FetchRemoteMeltQuoteContext<M>): Promise<MeltQuote<M>>;
  swap(ctx: SwapMeltContext<M>): Promise<{ keep: Proof[]; send: Proof[] }>;
  melt(ctx: ExecuteMeltContext<M>): Promise<MeltRemoteResult<M>>;
}

export type MeltMethodHandlerRegistry = Record<MeltMethod, MeltMethodHandler<any>>;
