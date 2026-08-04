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

type OptionalImportQuoteMetadata<T extends MintQuoteBaseResponse> = Omit<
  T,
  'method' | 'updated_at'
> &
  Partial<Pick<MintQuoteBaseResponse, 'method' | 'updated_at'>>;

/**
 * Compatibility for caller-provided legacy snapshots at Quote Lifecycle's public import seam.
 * These snapshots bypass cashu-ts wire normalization, so Coco derives missing canonical BOLT11
 * accounting or compatibility state before admitting them to the normalized runtime interface.
 */
export type CompatibleMintQuoteBolt11Response = Omit<
  OptionalImportQuoteMetadata<MintQuoteBolt11Response>,
  'amount' | 'amount_paid' | 'amount_issued' | 'state'
> & {
  amount: Amount;
  amount_paid?: Amount;
  amount_issued?: Amount;
  state?: MintQuoteBolt11Response['state'];
};
export type CompatibleMintQuoteOnchainResponse =
  OptionalImportQuoteMetadata<MintQuoteOnchainResponse>;
export type CompatibleMintQuoteBolt12Response = Omit<
  OptionalImportQuoteMetadata<MintQuoteBolt12Response>,
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
    createQuoteData: {
      amount: UnitAmount;
      locked?: boolean;
      /** Existing Coco-owned NUT-20 key to use instead of generating a fresh key. */
      ownedPubkey?: string;
    };
    quoteData: {
      amount: Amount;
    };
    /** @deprecated Compatibility projection of canonical Mint Quote Accounting. */
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
    };
    remoteState: never;
    quote: MintQuoteBolt12Response;
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
export type MintMethodQuoteImportSnapshot<M extends MintMethod = MintMethod> = M extends 'bolt11'
  ? CompatibleMintQuoteBolt11Response
  : M extends 'onchain'
    ? CompatibleMintQuoteOnchainResponse
    : M extends 'bolt12'
      ? CompatibleMintQuoteBolt12Response
      : never;

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

/** Repository-free context for a parent-authorized remote mint request. */
export type OwnedMintRemoteContext<M extends MintMethod = MintMethod> = Pick<
  ExecuteContext<M>,
  'operation' | 'wallet' | 'mintAdapter' | 'logger'
>;

export interface RecoverExecutingContext<
  M extends MintMethod = MintMethod,
> extends BaseHandlerDeps {
  operation: ExecutingMintOperation<M>;
  wallet: Wallet;
  localClaimabilityFacts: {
    finalizedAmount: Amount;
    reservedAmount: Amount;
  };
}

export interface PendingContext<M extends MintMethod = MintMethod> {
  operation: PendingMintOperation<M>;
  mintAdapter: MintAdapter;
  logger?: Logger;
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
  /** @deprecated Return `quoteSnapshot` with canonical accounting whenever available. */
  observedRemoteState?: MintMethodRemoteState<M>;
  observedRemoteStateAt: number;
  quoteSnapshot?: MintMethodQuoteSnapshot<M>;
  category: PendingMintCheckCategory;
  terminalFailure?: MintOperationFailure;
}

/**
 * Method-specific facts observed while checking a pending mint operation.
 *
 * Handlers validate whether remote responses belong to their operation. The durable mint saga
 * reconciles attributable snapshots and decides the resulting local operation state.
 */
export type PendingMintObservationResult<M extends MintMethod = MintMethod> =
  | {
      observedAt: number;
      quoteSnapshot: MintMethodQuoteSnapshot<M>;
      validationFailure?: never;
    }
  | {
      observedAt: number;
      quoteSnapshot?: MintMethodQuoteSnapshot<M>;
      validationFailure: MintOperationFailure;
    };

export interface MintMethodHandler<M extends MintMethod = MintMethod> {
  createQuote(ctx: CreateMintQuoteContext<M>): Promise<MintQuote<M>>;
  fetchRemoteQuote(ctx: FetchRemoteMintQuoteContext<M>): Promise<MintQuote<M>>;
  validateQuoteForPrepare?(quote: MintQuote<M>): Promise<void> | void;
  prepare(ctx: PrepareContext<M>): Promise<PendingMintOperation<M>>;
  execute(ctx: ExecuteContext<M>): Promise<MintExecutionResult>;
  /** Opt-in composition seam that cannot access repositories during remote I/O. */
  executeOwnedRemote?(ctx: OwnedMintRemoteContext<M>): Promise<MintExecutionResult>;
  recoverExecuting(ctx: RecoverExecutingContext<M>): Promise<RecoverExecutingResult>;
  checkPending(ctx: PendingContext<M>): Promise<PendingMintObservationResult<M>>;
}

export type MintMethodHandlerRegistry = {
  [M in MintMethod]: MintMethodHandler<M>;
};
