import type { Amount, MintQuoteBolt11Response, Proof, Wallet } from '@cashu/cashu-ts';
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
import type { MintBatchAttempt } from './MintBatchAttempt';
import type { MintAdapter } from '../../infra/MintAdapter';

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

export interface SingleOutputPrepareContext<M extends MintMethod = MintMethod>
  extends BaseHandlerDeps {
  operation: PendingMintOperation<M>;
  wallet: Wallet;
}

export interface BatchSupportContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  operation: PendingMintOperation<M>;
  wallet: Wallet;
}

export interface BatchPrepareContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  operations: PendingMintOperation<M>[];
  totalAmount: Amount;
  quoteAmounts: Amount[];
  wallet: Wallet;
  keysetId: string;
}

export interface BatchExecuteContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  attempt: MintBatchAttempt<M>;
  operations: PendingMintOperation<M>[];
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

export interface MintBatchSupport {
  supported: boolean;
  reason?: string;
}

export type MintBatchExecutionResult =
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
      retryable?: boolean;
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
  prepare(ctx: PrepareContext<M>): Promise<PendingMintOperation<M>>;
  prepareSingleOutput?(ctx: SingleOutputPrepareContext<M>): Promise<PendingMintOperation<M>>;
  execute(ctx: ExecuteContext<M>): Promise<MintExecutionResult>;
  assessBatchSupport?(ctx: BatchSupportContext<M>): Promise<MintBatchSupport> | MintBatchSupport;
  prepareBatch?(ctx: BatchPrepareContext<M>): Promise<MintBatchAttempt<M>>;
  executeBatch?(ctx: BatchExecuteContext<M>): Promise<MintBatchExecutionResult>;
  recoverExecuting(ctx: RecoverExecutingContext<M>): Promise<RecoverExecutingResult>;
  checkPending(ctx: PendingContext<M>): Promise<PendingMintCheckResult<M>>;
}

export type MintMethodHandlerRegistry = {
  [M in MintMethod]: MintMethodHandler<M>;
};
