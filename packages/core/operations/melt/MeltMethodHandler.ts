import {
  Amount,
  type AmountLike,
  type MeltQuoteBolt11Response,
  type MeltQuoteBolt12Response,
  type MeltQuoteOnchainResponse,
  type Wallet,
  type Proof,
} from '@cashu/cashu-ts';
import type { ProofRepository } from '../../repositories';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { MintService } from '../../services/MintService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import type {
  ExecutingMeltOperation,
  FailedMeltOperation,
  FinalizedMeltOperation,
  InitMeltOperation,
  MeltMethodFinalizedData,
  PendingMeltOperation,
  PreparedMeltOperation,
  PreparedOrLaterOperation,
} from './MeltOperation';
import type { MintAdapter } from '@core/infra';
import type { MeltQuote } from '../../models/MeltQuote';

export type BuiltInMeltMethod = 'bolt11' | 'bolt12' | 'onchain';
export type MeltMethod = BuiltInMeltMethod | (string & {});
export type GenericMeltMethod<M extends string = string> = M extends BuiltInMeltMethod ? never : M;

export const BUILT_IN_MELT_METHODS = ['bolt11', 'bolt12', 'onchain'] as const;

export function isBuiltInMeltMethod(method: string): method is BuiltInMeltMethod {
  return (BUILT_IN_MELT_METHODS as readonly string[]).includes(method);
}

export function assertGenericMeltMethod(method: string): void {
  if (isBuiltInMeltMethod(method)) {
    throw new Error(`Built-in melt method ${method} must use the built-in melt quote API`);
  }
}

export type GenericMeltMethodInputData = {
  request: string;
  payload?: Record<string, unknown>;
};

export type GenericMeltMethodData = GenericMeltMethodInputData;

export type GenericMeltQuoteSnapshot = {
  quote: string;
  request: string;
  amount: Amount;
  unit: string;
  fee_reserve?: AmountLike;
  expiry: number;
  state: 'UNPAID' | 'PENDING' | 'PAID';
  payment_preimage?: string | null;
  change?: MeltQuoteBolt11Response['change'];
} & Record<string, unknown>;

type BuiltInMeltMethodInputMap = {
  bolt11: { invoice: string; amountSats?: AmountLike };
  bolt12: { offer: string; amountSats?: AmountLike };
  onchain: { address: string; amountSats: AmountLike };
};

/**
 * Registry of supported melt methods and their normalized operation payload shapes.
 * Amount values are normalized at the operation boundary.
 */
type BuiltInMeltMethodDataMap = {
  bolt11: { invoice: string; amountSats?: Amount };
  bolt12: { offer: string; amountSats?: Amount };
  onchain: { address: string; amountSats: Amount; feeIndex?: number };
};

type BuiltInMeltMethodQuoteMap = {
  bolt11: MeltQuoteBolt11Response;
  bolt12: MeltQuoteBolt12Response;
  onchain: MeltQuoteOnchainResponse;
};

export type MeltMethodInputData<M extends MeltMethod = BuiltInMeltMethod> =
  M extends BuiltInMeltMethod ? BuiltInMeltMethodInputMap[M] : GenericMeltMethodInputData;

export type MeltMethodData<M extends MeltMethod = BuiltInMeltMethod> = M extends BuiltInMeltMethod
  ? BuiltInMeltMethodDataMap[M]
  : GenericMeltMethodData;

export type MeltMethodRemoteState<M extends MeltMethod = BuiltInMeltMethod> =
  MeltMethodQuoteSnapshot<M>['state'];

export type MeltMethodQuoteSnapshot<M extends MeltMethod = BuiltInMeltMethod> =
  M extends BuiltInMeltMethod ? BuiltInMeltMethodQuoteMap[M] : GenericMeltQuoteSnapshot;

export interface MeltMethodMeta<M extends MeltMethod = BuiltInMeltMethod> {
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

export interface BaseHandlerDeps {
  proofRepository: ProofRepository;
  proofService: ProofService;
  walletService: WalletService;
  mintService: MintService;
  mintAdapter: MintAdapter;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
}

export interface CreateMeltQuoteContext<
  M extends MeltMethod = BuiltInMeltMethod,
> extends BaseHandlerDeps {
  mintUrl: string;
  method: M;
  methodData: MeltMethodData<M>;
  unit: string;
  wallet: Wallet;
}

export interface FetchRemoteMeltQuoteContext<
  M extends MeltMethod = BuiltInMeltMethod,
> extends BaseHandlerDeps {
  quote: MeltQuote<M>;
}

export interface BasePrepareContext<
  M extends MeltMethod = BuiltInMeltMethod,
> extends BaseHandlerDeps {
  operation: InitMeltOperation<M>;
  wallet: Wallet;
  quote: MeltMethodQuoteSnapshot<M>;
}

export interface PreparedContext<M extends MeltMethod = BuiltInMeltMethod> extends BaseHandlerDeps {
  operation: PreparedMeltOperation<M>;
  wallet: Wallet;
}

export interface ExecuteContext<M extends MeltMethod = BuiltInMeltMethod> extends BaseHandlerDeps {
  operation: ExecutingMeltOperation<M>;
  wallet: Wallet;
  reservedProofs: Proof[];
}

export interface PendingContext<M extends MeltMethod = BuiltInMeltMethod> extends BaseHandlerDeps {
  operation: PendingMeltOperation<M>;
  wallet: Wallet;
}

export interface FinalizeContext<M extends MeltMethod = BuiltInMeltMethod> extends BaseHandlerDeps {
  operation: PendingMeltOperation<M>;
}

export type FinalizeResult<M extends MeltMethod = BuiltInMeltMethod> = {
  /** Total amount returned as change by the mint */
  changeAmount?: Amount;
  /** Actual fee impact after settlement */
  effectiveFee?: Amount;
  /** Method-specific data that may be available once settlement completes */
  finalizedData?: MeltMethodFinalizedData<M>;
};

export interface RollbackContext<M extends MeltMethod = BuiltInMeltMethod> extends BaseHandlerDeps {
  operation: PreparedOrLaterOperation<M>;
  wallet: Wallet;
}

export interface RecoverExecutingContext<
  M extends MeltMethod = BuiltInMeltMethod,
> extends BaseHandlerDeps {
  operation: ExecutingMeltOperation<M>;
  wallet: Wallet;
}

export type ExecutionResult<M extends MeltMethod = BuiltInMeltMethod> =
  | {
      status: 'PAID';
      finalized: FinalizedMeltOperation<M>;
      sendProofs?: Proof[];
      keepProofs?: Proof[];
    }
  | {
      status: 'PENDING';
      pending: PendingMeltOperation<M>;
      sendProofs?: Proof[];
      keepProofs?: Proof[];
    }
  | {
      status: 'FAILED';
      failed: FailedMeltOperation<M>;
      sendProofs?: Proof[];
      keepProofs?: Proof[];
    };

export type PendingCheckResult = 'finalize' | 'stay_pending' | 'rollback';

export interface MeltMethodHandler<M extends MeltMethod = BuiltInMeltMethod> {
  createQuote(ctx: CreateMeltQuoteContext<M>): Promise<MeltQuote<M>>;
  fetchRemoteQuote(ctx: FetchRemoteMeltQuoteContext<M>): Promise<MeltQuote<M>>;
  prepare(ctx: BasePrepareContext<M>): Promise<PreparedMeltOperation<M>>;
  execute(ctx: ExecuteContext<M>): Promise<ExecutionResult<M>>;
  finalize?(ctx: FinalizeContext<M>): Promise<FinalizeResult<M>>;
  rollback?(ctx: RollbackContext<M>): Promise<void>;
  checkPending?(ctx: PendingContext<M>): Promise<PendingCheckResult>;
  /**
   * Recover an executing operation that failed mid-execution.
   * Handlers must implement this method to handle recovery logic.
   */
  recoverExecuting(ctx: RecoverExecutingContext<M>): Promise<ExecutionResult<M>>;
}

export type MeltMethodHandlerRegistry = {
  [M in BuiltInMeltMethod]: MeltMethodHandler<M>;
};
