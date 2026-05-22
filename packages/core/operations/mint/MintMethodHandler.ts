import type { MintQuoteBolt11Response, Proof, Wallet } from '@cashu/cashu-ts';
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

/**
 * Registry of supported mint methods and payload shapes.
 * Extend via declaration merging to support additional methods.
 */
export interface MintMethodDefinitions {
  bolt11: {
    methodData: Record<string, never>;
    remoteState: 'UNPAID' | 'PAID' | 'ISSUED';
    quote: MintQuoteBolt11Response;
  };
}

export type MintMethod = keyof MintMethodDefinitions;
export type MintMethodData<M extends MintMethod = MintMethod> =
  MintMethodDefinitions[M]['methodData'];
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
  intent: UnitAmount;
  wallet: Wallet;
}

export interface RefreshMintQuoteContext<
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
  observedRemoteState: MintMethodRemoteState<M>;
  observedRemoteStateAt: number;
  category: PendingMintCheckCategory;
  terminalFailure?: MintOperationFailure;
}

export interface MintMethodHandler<M extends MintMethod = MintMethod> {
  createQuote(ctx: CreateMintQuoteContext<M>): Promise<MintQuote<M>>;
  refreshQuote(ctx: RefreshMintQuoteContext<M>): Promise<MintQuote<M>>;
  prepare(ctx: PrepareContext<M>): Promise<PendingMintOperation<M>>;
  execute(ctx: ExecuteContext<M>): Promise<MintExecutionResult>;
  recoverExecuting(ctx: RecoverExecutingContext<M>): Promise<RecoverExecutingResult>;
  checkPending(ctx: PendingContext<M>): Promise<PendingMintCheckResult<M>>;
}

export type MintMethodHandlerRegistry = {
  [M in MintMethod]: MintMethodHandler<M>;
};
