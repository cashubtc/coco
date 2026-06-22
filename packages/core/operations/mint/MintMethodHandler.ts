import type {
  Amount,
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

declare const validatedGenericMintMethodBrand: unique symbol;

export type ValidatedGenericMintMethod = string & {
  readonly [validatedGenericMintMethodBrand]: true;
};

export type GenericMintMethod<M extends string = ValidatedGenericMintMethod> =
  M extends ValidatedGenericMintMethod
    ? M
    : string extends M
      ? never
      : Extract<M, BuiltInMintMethod> extends never
        ? M
        : never;

export type GenericMintMethodValue<M extends string> = M extends ValidatedGenericMintMethod
  ? M
  : Extract<M, BuiltInMintMethod> extends never
    ? string extends M
      ? ValidatedGenericMintMethod
      : GenericMintMethod<M>
    : never;

export interface GenericMintQuoteSnapshot {
  quote: string;
  request: string;
  unit: string;
  expiry?: number | null;
  pubkey: string;
  amount_paid: Amount;
  amount_issued: Amount;
  [key: string]: unknown;
}

export interface GenericMintQuoteData {
  pubkey: string;
  amountPaid: Amount;
  amountIssued: Amount;
}

export type GenericMintQuoteCreatePayload = Record<string, unknown> & {
  amount?: never;
  unit?: never;
  pubkey?: never;
};

export interface GenericMintQuoteCreateData {
  amount: UnitAmount;
  payload?: GenericMintQuoteCreatePayload;
}

type BuiltInMintMethodDefinitions = {
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

export type MintMethod = BuiltInMintMethod;
export type MintMethodData<M extends string = MintMethod> = M extends BuiltInMintMethod
  ? BuiltInMintMethodDefinitions[M]['methodData']
  : GenericMintMethod<M> extends never
    ? never
    : Record<string, unknown>;
export type MintMethodCreateQuoteData<M extends string = MintMethod> = M extends BuiltInMintMethod
  ? BuiltInMintMethodDefinitions[M]['createQuoteData']
  : GenericMintMethod<M> extends never
    ? never
    : GenericMintQuoteCreateData;
export type MintMethodQuoteData<M extends string = MintMethod> = M extends BuiltInMintMethod
  ? BuiltInMintMethodDefinitions[M]['quoteData']
  : GenericMintMethod<M> extends never
    ? never
    : GenericMintQuoteData;
export type MintMethodRemoteState<M extends string = MintMethod> = M extends BuiltInMintMethod
  ? BuiltInMintMethodDefinitions[M]['remoteState']
  : GenericMintMethod<M> extends never
    ? never
    : never;
export type MintMethodQuoteSnapshot<M extends string = MintMethod> = M extends BuiltInMintMethod
  ? BuiltInMintMethodDefinitions[M]['quote']
  : GenericMintMethod<M> extends never
    ? never
    : GenericMintQuoteSnapshot;

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
