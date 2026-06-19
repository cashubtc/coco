import type {
  Amount,
  AmountLike,
  MintQuoteBolt11Response,
  MintQuoteOnchainResponse,
  MintQuoteBolt12Response,
  Proof,
  Wallet,
} from '@cashu/cashu-ts';
import type { ProofRepository } from '../../repositories';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { MintService } from '../../services/MintService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import type {
  ExecutingMintOperation,
  InitMintOperation,
  MintOperationFailure,
  PendingMintOperation,
} from './MintOperation';
import type { MintAdapter } from '../../infra/MintAdapter';
import type { UnitAmount } from '../../amounts.ts';
import type { MintQuote } from '../../models/MintQuote';

export type BuiltInMintMethod = 'bolt11' | 'onchain' | 'bolt12';
export type MintMethod = BuiltInMintMethod | (string & {});
export type GenericMintMethod<M extends string = string> = M extends BuiltInMintMethod ? never : M;

export const BUILT_IN_MINT_METHODS = ['bolt11', 'onchain', 'bolt12'] as const;

export function isBuiltInMintMethod(method: string): method is BuiltInMintMethod {
  return (BUILT_IN_MINT_METHODS as readonly string[]).includes(method);
}

export function assertGenericMintMethod(method: string): void {
  if (!isBuiltInMintMethod(method)) return;
  throw new Error(`Built-in mint method ${method} must use the built-in mint quote API`);
}

export type GenericMintQuoteCreateData = {
  amount: UnitAmount;
  unit: string;
  payload?: Record<string, unknown>;
};

export type GenericMintQuoteData = {
  pubkey?: string;
  amountPaid: Amount;
  amountIssued: Amount;
};

export type GenericMintQuoteSnapshot = {
  quote: string;
  request: string;
  unit: string;
  expiry?: number | null;
  pubkey?: string;
  amount_paid: AmountLike;
  amount_issued: AmountLike;
} & Record<string, unknown>;

type BuiltInMintMethodMap = {
  bolt11: {
    methodData: Record<string, never>;
    createQuoteData: { amount: UnitAmount };
    quoteData: {
      amount: Amount;
    };
    remoteState: 'UNPAID' | 'PAID' | 'ISSUED';
    quote: MintQuoteBolt11Response;
  };
  onchain: {
    methodData: Record<string, never>;
    createQuoteData: {
      unit: string;
    };
    quoteData: {
      pubkey: string;
      amountPaid: Amount;
      amountIssued: Amount;
    };
    remoteState: never;
    quote: MintQuoteOnchainResponse;
  };
  bolt12: {
    methodData: Record<string, never>;
    createQuoteData: {
      unit: string;
      amount?: UnitAmount;
      description?: string;
    };
    quoteData: {
      pubkey: string;
      amount?: Amount;
      amountPaid: Amount;
      amountIssued: Amount;
    };
    remoteState: never;
    quote: MintQuoteBolt12Response;
  };
};

type GenericMintMethodDefinition = {
  methodData: Record<string, unknown>;
  createQuoteData: GenericMintQuoteCreateData;
  quoteData: GenericMintQuoteData;
  remoteState: never;
  quote: GenericMintQuoteSnapshot;
};

type MintMethodDefinition<M extends MintMethod> = M extends BuiltInMintMethod
  ? BuiltInMintMethodMap[M]
  : GenericMintMethodDefinition;

export type MintMethodData<M extends MintMethod = BuiltInMintMethod> =
  MintMethodDefinition<M>['methodData'];
export type MintMethodCreateQuoteData<M extends MintMethod = BuiltInMintMethod> =
  MintMethodDefinition<M>['createQuoteData'];
export type MintMethodQuoteData<M extends MintMethod = BuiltInMintMethod> =
  MintMethodDefinition<M>['quoteData'];
export type MintMethodRemoteState<M extends MintMethod = BuiltInMintMethod> =
  MintMethodDefinition<M>['remoteState'];
export type MintMethodQuoteSnapshot<M extends MintMethod = BuiltInMintMethod> =
  MintMethodDefinition<M>['quote'];

export interface MintMethodMeta<M extends MintMethod = BuiltInMintMethod> {
  method: M;
  methodData: MintMethodData<M>;
}

export interface BaseHandlerDeps {
  proofRepository: ProofRepository;
  proofService: ProofService;
  walletService: WalletService;
  mintService: MintService;
  mintAdapter: MintAdapter;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
}

export interface CreateMintQuoteContext<
  M extends MintMethod = BuiltInMintMethod,
> extends BaseHandlerDeps {
  mintUrl: string;
  method: M;
  createQuoteData: MintMethodCreateQuoteData<M>;
  wallet: Wallet;
}

export interface FetchRemoteMintQuoteContext<
  M extends MintMethod = BuiltInMintMethod,
> extends BaseHandlerDeps {
  quote: MintQuote<M>;
}

export interface PrepareContext<M extends MintMethod = BuiltInMintMethod> extends BaseHandlerDeps {
  operation: InitMintOperation<M>;
  wallet: Wallet;
  importedQuote?: MintMethodQuoteSnapshot<M>;
}

export interface ExecuteContext<M extends MintMethod = BuiltInMintMethod> extends BaseHandlerDeps {
  operation: ExecutingMintOperation<M>;
  wallet: Wallet;
}

export interface RecoverExecutingContext<
  M extends MintMethod = BuiltInMintMethod,
> extends BaseHandlerDeps {
  operation: ExecutingMintOperation<M>;
  wallet: Wallet;
}

export interface PendingContext<M extends MintMethod = BuiltInMintMethod> extends BaseHandlerDeps {
  operation: PendingMintOperation<M>;
  wallet: Wallet;
}

export type MintExecutionResult =
  | {
      status: 'ISSUED';
      proofs: Proof[];
    }
  | {
      status: 'ALREADY_ISSUED';
    }
  | {
      status: 'FAILED';
      error?: string;
    };

export type RecoverExecutingResult =
  | { status: 'FINALIZED' }
  | { status: 'TERMINAL'; error: string }
  | { status: 'PENDING'; error?: string };

export type PendingMintCheckCategory = 'waiting' | 'ready' | 'completed' | 'terminal';

export interface PendingMintCheckResult<M extends MintMethod = BuiltInMintMethod> {
  observedRemoteState?: MintMethodRemoteState<M>;
  observedRemoteStateAt: number;
  quoteSnapshot?: MintMethodQuoteSnapshot<M>;
  category: PendingMintCheckCategory;
  terminalFailure?: MintOperationFailure;
}

export interface MintMethodHandler<M extends MintMethod = BuiltInMintMethod> {
  createQuote(ctx: CreateMintQuoteContext<M>): Promise<MintQuote<M>>;
  fetchRemoteQuote(ctx: FetchRemoteMintQuoteContext<M>): Promise<MintQuote<M>>;
  validateQuoteForPrepare?(quote: MintQuote<M>): Promise<void> | void;
  prepare(ctx: PrepareContext<M>): Promise<PendingMintOperation<M>>;
  execute(ctx: ExecuteContext<M>): Promise<MintExecutionResult>;
  recoverExecuting(ctx: RecoverExecutingContext<M>): Promise<RecoverExecutingResult>;
  checkPending(ctx: PendingContext<M>): Promise<PendingMintCheckResult<M>>;
}

export type MintMethodHandlerRegistry = {
  [M in BuiltInMintMethod]: MintMethodHandler<M>;
};
