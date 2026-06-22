import {
  Amount,
  type AmountLike,
  type MeltQuoteBolt11Response,
  type MeltQuoteBolt12Response,
  type MeltQuoteOnchainResponse,
  type Wallet,
  type Proof,
  type SerializedBlindedSignature,
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

declare const validatedGenericMeltMethodBrand: unique symbol;

export type ValidatedGenericMeltMethod = string & {
  readonly [validatedGenericMeltMethodBrand]: true;
};

export type GenericMeltMethod<M extends string = ValidatedGenericMeltMethod> =
  M extends ValidatedGenericMeltMethod
    ? M
    : string extends M
      ? never
      : Extract<M, BuiltInMeltMethod> extends never
        ? M
        : never;

export type GenericMeltMethodValue<M extends string> = M extends ValidatedGenericMeltMethod
  ? M
  : Extract<M, BuiltInMeltMethod> extends never
    ? string extends M
      ? ValidatedGenericMeltMethod
      : GenericMeltMethod<M>
    : never;

export type GenericMeltMethodInputData = {
  request: string;
  unit?: never;
} & Record<string, unknown>;

export interface GenericMeltMethodData {
  request: string;
  [key: string]: unknown;
}

export interface GenericMeltQuoteSnapshot {
  quote: string;
  request: string;
  amount: Amount;
  unit: string;
  expiry: number;
  state: 'UNPAID' | 'PENDING' | 'PAID';
  fee_reserve?: Amount;
  payment_preimage?: string | null;
  change?: SerializedBlindedSignature[];
  [key: string]: unknown;
}

type BuiltInMeltMethodInputDefinitions = {
  bolt11: { invoice: string; amountSats?: AmountLike };
  bolt12: { offer: string; amountSats?: AmountLike };
  onchain: { address: string; amountSats: AmountLike };
};

type BuiltInMeltMethodDefinitions = {
  bolt11: { invoice: string; amountSats?: Amount };
  bolt12: { offer: string; amountSats?: Amount };
  onchain: { address: string; amountSats: Amount; feeIndex?: number };
};

export type MeltMethod = BuiltInMeltMethod;

export type MeltMethodData<M extends string = MeltMethod> = M extends BuiltInMeltMethod
  ? BuiltInMeltMethodDefinitions[M]
  : GenericMeltMethod<M> extends never
    ? never
    : GenericMeltMethodData;

type BuiltInMeltMethodQuoteDefinitions = {
  bolt11: MeltQuoteBolt11Response;
  bolt12: MeltQuoteBolt12Response;
  onchain: MeltQuoteOnchainResponse;
};

export type MeltMethodInputData<M extends string = MeltMethod> = M extends BuiltInMeltMethod
  ? BuiltInMeltMethodInputDefinitions[M]
  : GenericMeltMethod<M> extends never
    ? never
    : GenericMeltMethodInputData;

export type MeltMethodRemoteState<M extends string = MeltMethod> = M extends BuiltInMeltMethod
  ? BuiltInMeltMethodQuoteDefinitions[M]['state']
  : GenericMeltMethod<M> extends never
    ? never
    : GenericMeltQuoteSnapshot['state'];

export type MeltMethodQuoteSnapshot<M extends string = MeltMethod> = M extends BuiltInMeltMethod
  ? BuiltInMeltMethodQuoteDefinitions[M]
  : GenericMeltMethod<M> extends never
    ? never
    : GenericMeltQuoteSnapshot;

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

export interface BaseHandlerDeps {
  proofRepository: ProofRepository;
  proofService: ProofService;
  walletService: WalletService;
  mintService: MintService;
  mintAdapter: MintAdapter;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
}

export interface CreateMeltQuoteContext<M extends MeltMethod = MeltMethod> extends BaseHandlerDeps {
  mintUrl: string;
  methodData: MeltMethodData<M>;
  unit: string;
  wallet: Wallet;
}

export interface FetchRemoteMeltQuoteContext<
  M extends MeltMethod = MeltMethod,
> extends BaseHandlerDeps {
  quote: MeltQuote<M>;
}

export interface BasePrepareContext<M extends MeltMethod = MeltMethod> extends BaseHandlerDeps {
  operation: InitMeltOperation & MeltMethodMeta<M>;
  wallet: Wallet;
  quote: MeltMethodQuoteSnapshot<M>;
}

export interface PreparedContext<M extends MeltMethod = MeltMethod> extends BaseHandlerDeps {
  operation: PreparedMeltOperation & MeltMethodMeta<M>;
  wallet: Wallet;
}

export interface ExecuteContext<M extends MeltMethod = MeltMethod> extends BaseHandlerDeps {
  operation: ExecutingMeltOperation & MeltMethodMeta<M>;
  wallet: Wallet;
  reservedProofs: Proof[];
}

export interface PendingContext<M extends MeltMethod = MeltMethod> extends BaseHandlerDeps {
  operation: PendingMeltOperation & MeltMethodMeta<M>;
  wallet: Wallet;
}

export interface FinalizeContext<M extends MeltMethod = MeltMethod> extends BaseHandlerDeps {
  operation: PendingMeltOperation & MeltMethodMeta<M>;
}

export type FinalizeResult<M extends MeltMethod = MeltMethod> = {
  /** Total amount returned as change by the mint */
  changeAmount?: Amount;
  /** Actual fee impact after settlement */
  effectiveFee?: Amount;
  /** Method-specific data that may be available once settlement completes */
  finalizedData?: MeltMethodFinalizedData<M>;
};

export interface RollbackContext<M extends MeltMethod = MeltMethod> extends BaseHandlerDeps {
  operation: PreparedOrLaterOperation & MeltMethodMeta<M>;
  wallet: Wallet;
}

export interface RecoverExecutingContext<
  M extends MeltMethod = MeltMethod,
> extends BaseHandlerDeps {
  operation: ExecutingMeltOperation & MeltMethodMeta<M>;
  wallet: Wallet;
}

export type ExecutionResult<M extends MeltMethod = MeltMethod> =
  | {
      status: 'PAID';
      finalized: FinalizedMeltOperation<M>;
      sendProofs?: Proof[];
      keepProofs?: Proof[];
    }
  | {
      status: 'PENDING';
      pending: PendingMeltOperation & MeltMethodMeta<M>;
      sendProofs?: Proof[];
      keepProofs?: Proof[];
    }
  | {
      status: 'FAILED';
      failed: FailedMeltOperation & MeltMethodMeta<M>;
      sendProofs?: Proof[];
      keepProofs?: Proof[];
    };

export type PendingCheckResult = 'finalize' | 'stay_pending' | 'rollback';

export interface MeltMethodHandler<M extends MeltMethod = MeltMethod> {
  createQuote(ctx: CreateMeltQuoteContext<M>): Promise<MeltQuote<M>>;
  fetchRemoteQuote(ctx: FetchRemoteMeltQuoteContext<M>): Promise<MeltQuote<M>>;
  prepare(ctx: BasePrepareContext<M>): Promise<PreparedMeltOperation & MeltMethodMeta<M>>;
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

export type MeltMethodHandlerRegistry = Record<MeltMethod, MeltMethodHandler<any>>;
