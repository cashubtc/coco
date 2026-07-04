import type {
  Amount,
  MintQuoteBaseResponse,
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

type OptionalV5QuoteBase<T extends MintQuoteBaseResponse> = Omit<
  T,
  'method' | 'amount_paid' | 'amount_issued' | 'updated_at'
> &
  Partial<Pick<MintQuoteBaseResponse, 'method' | 'amount_paid' | 'amount_issued' | 'updated_at'>>;

/**
 * Temporary compatibility for caller-provided legacy snapshots at Coco's quote lifecycle boundary.
 * MintAdapter responses still come from cashu-ts v5 normalized Mint/Wallet APIs; later accounting
 * slices can retire the optional accounting fields once Coco's canonical quote model owns them.
 */
export type CompatibleMintQuoteBolt11Response = Omit<
  OptionalV5QuoteBase<MintQuoteBolt11Response>,
  'amount' | 'state'
> & {
  amount: Amount;
  state?: MintQuoteBolt11Response['state'];
};
export type CompatibleMintQuoteOnchainResponse = OptionalV5QuoteBase<MintQuoteOnchainResponse>;
export type CompatibleMintQuoteBolt12Response = Omit<
  OptionalV5QuoteBase<MintQuoteBolt12Response>,
  'amount'
> & {
  amount?: Amount | null;
};

/**
 * Registry of supported mint methods and payload shapes.
 * Extend via declaration merging to support additional methods.
 */
export interface MintMethodDefinitions {
  bolt11: {
    methodData: Record<string, never>;
    createQuoteData: { amount: UnitAmount };
    quoteData: {
      amount: Amount;
    };
    remoteState: 'UNPAID' | 'PAID' | 'ISSUED';
    quote: CompatibleMintQuoteBolt11Response;
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
    quote: CompatibleMintQuoteOnchainResponse;
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
    quote: CompatibleMintQuoteBolt12Response;
  };
}

export type MintMethod = keyof MintMethodDefinitions;
export type MintMethodData<M extends MintMethod = MintMethod> =
  MintMethodDefinitions[M]['methodData'];
export type MintMethodCreateQuoteData<M extends MintMethod = MintMethod> =
  MintMethodDefinitions[M]['createQuoteData'];
export type MintMethodQuoteData<M extends MintMethod = MintMethod> =
  MintMethodDefinitions[M]['quoteData'];
export type MintMethodRemoteState<M extends MintMethod = MintMethod> =
  MintMethodDefinitions[M]['remoteState'];
export type MintMethodQuoteSnapshot<M extends MintMethod = MintMethod> =
  MintMethodDefinitions[M]['quote'];

export interface MintMethodMeta<M extends MintMethod = MintMethod> {
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

export interface CreateMintQuoteContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  mintUrl: string;
  createQuoteData: MintMethodCreateQuoteData<M>;
  wallet: Wallet;
}

export interface FetchRemoteMintQuoteContext<
  M extends MintMethod = MintMethod,
> extends BaseHandlerDeps {
  quote: MintQuote<M>;
}

export interface PrepareContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  operation: InitMintOperation<M>;
  wallet: Wallet;
  importedQuote?: MintMethodQuoteSnapshot<M>;
}

export interface ExecuteContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  operation: ExecutingMintOperation<M>;
  wallet: Wallet;
}

export interface RecoverExecutingContext<
  M extends MintMethod = MintMethod,
> extends BaseHandlerDeps {
  operation: ExecutingMintOperation<M>;
  wallet: Wallet;
}

export interface PendingContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
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

export interface PendingMintCheckResult<M extends MintMethod = MintMethod> {
  observedRemoteState?: MintMethodRemoteState<M>;
  observedRemoteStateAt: number;
  quoteSnapshot?: MintMethodQuoteSnapshot<M>;
  category: PendingMintCheckCategory;
  terminalFailure?: MintOperationFailure;
}

export interface MintMethodHandler<M extends MintMethod = MintMethod> {
  createQuote(ctx: CreateMintQuoteContext<M>): Promise<MintQuote<M>>;
  fetchRemoteQuote(ctx: FetchRemoteMintQuoteContext<M>): Promise<MintQuote<M>>;
  validateQuoteForPrepare?(quote: MintQuote<M>): Promise<void> | void;
  prepare(ctx: PrepareContext<M>): Promise<PendingMintOperation<M>>;
  execute(ctx: ExecuteContext<M>): Promise<MintExecutionResult>;
  recoverExecuting(ctx: RecoverExecutingContext<M>): Promise<RecoverExecutingResult>;
  checkPending(ctx: PendingContext<M>): Promise<PendingMintCheckResult<M>>;
}

export type MintMethodHandlerRegistry = {
  [M in MintMethod]: MintMethodHandler<M>;
};
