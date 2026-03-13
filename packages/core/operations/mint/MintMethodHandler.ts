import type { Proof, Wallet } from '@cashu/cashu-ts';
import type { MintQuoteRepository, ProofRepository } from '../../repositories';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { MintService } from '../../services/MintService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import type {
  ExecutingMintOperation,
  InitMintOperation,
  PreparedMintOperation,
} from './MintOperation';
import type { MintAdapter } from '../../infra/MintAdapter';

/**
 * Registry of supported mint methods and payload shapes.
 * Extend via declaration merging to support additional methods.
 */
export interface MintMethodDefinitions {
  bolt11: Record<string, never>;
}

export type MintMethod = keyof MintMethodDefinitions;
export type MintMethodData<M extends MintMethod = MintMethod> = MintMethodDefinitions[M];

export interface MintMethodMeta<M extends MintMethod = MintMethod> {
  method: M;
  methodData: MintMethodData<M>;
}

export interface BaseHandlerDeps {
  mintQuoteRepository: MintQuoteRepository;
  proofRepository: ProofRepository;
  proofService: ProofService;
  walletService: WalletService;
  mintService: MintService;
  mintAdapter: MintAdapter;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
}

export interface PrepareContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  operation: InitMintOperation & MintMethodMeta<M>;
  wallet: Wallet;
}

export interface ExecuteContext<M extends MintMethod = MintMethod> extends BaseHandlerDeps {
  operation: ExecutingMintOperation & MintMethodMeta<M>;
  wallet: Wallet;
}

export interface RecoverExecutingContext<
  M extends MintMethod = MintMethod,
> extends BaseHandlerDeps {
  operation: ExecutingMintOperation & MintMethodMeta<M>;
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
  | { status: 'STAY_EXECUTING' }
  | { status: 'ROLLED_BACK'; error: string };

export interface MintMethodHandler<M extends MintMethod = MintMethod> {
  prepare(ctx: PrepareContext<M>): Promise<PreparedMintOperation & MintMethodMeta<M>>;
  execute(ctx: ExecuteContext<M>): Promise<MintExecutionResult>;
  recoverExecuting(ctx: RecoverExecutingContext<M>): Promise<RecoverExecutingResult>;
}

export type MintMethodHandlerRegistry = Record<MintMethod, MintMethodHandler<MintMethod>>;
