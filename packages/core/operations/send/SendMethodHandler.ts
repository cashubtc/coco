import type { Wallet, Proof, Token } from '@cashu/cashu-ts';
import type { ProofRepository } from '../../repositories';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { MintService } from '../../services/MintService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import type {
  ExecutingSendOperation,
  InitSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  PreparedOrLaterOperation,
  RolledBackSendOperation,
} from './SendOperation';

/**
 * Registry of supported send methods and their payload shapes.
 * Extend via declaration merging if you need to add methods externally.
 *
 * Future methods may include:
 * - p2pk: { pubkey: string } - P2PK locked tokens
 * - htlc: { hash: string; timeout: number } - HTLC locked tokens
 */
export interface SendMethodDefinitions {
  default: Record<string, never>;
}

export type SendMethod = keyof SendMethodDefinitions;

export type SendMethodData<M extends SendMethod = SendMethod> = SendMethodDefinitions[M];

// ---------------------------------------------------------------------------
// Contexts / Results
// ---------------------------------------------------------------------------

export interface BaseHandlerDeps {
  proofRepository: ProofRepository;
  proofService: ProofService;
  walletService: WalletService;
  mintService: MintService;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
}

export interface BasePrepareContext extends BaseHandlerDeps {
  operation: InitSendOperation;
  wallet: Wallet;
}

export interface PreparedContext extends BaseHandlerDeps {
  operation: PreparedSendOperation;
  wallet: Wallet;
}

export interface ExecuteContext extends BaseHandlerDeps {
  operation: ExecutingSendOperation;
  wallet: Wallet;
  reservedProofs: Proof[];
}

export interface PendingContext extends BaseHandlerDeps {
  operation: PendingSendOperation;
  wallet: Wallet;
}

export interface FinalizeContext extends BaseHandlerDeps {
  operation: PendingSendOperation;
}

export interface RollbackContext extends BaseHandlerDeps {
  operation: PreparedOrLaterOperation;
  wallet: Wallet;
}

export interface RecoverExecutingContext extends BaseHandlerDeps {
  operation: ExecutingSendOperation;
  wallet: Wallet;
}

export type ExecutionResult =
  | {
      status: 'PENDING';
      pending: PendingSendOperation;
      token: Token;
    }
  | {
      status: 'FAILED';
      failed: RolledBackSendOperation;
    };

export type PendingCheckResult = 'finalize' | 'stay_pending' | 'rollback';

export interface SendMethodHandler<M extends SendMethod = SendMethod> {
  prepare(ctx: BasePrepareContext): Promise<PreparedSendOperation>;
  execute(ctx: ExecuteContext): Promise<ExecutionResult>;
  finalize?(ctx: FinalizeContext): Promise<void>;
  rollback?(ctx: RollbackContext): Promise<void>;
  checkPending?(ctx: PendingContext): Promise<PendingCheckResult>;
  /**
   * Recover an executing operation that failed mid-execution.
   * Handlers must implement this method to handle recovery logic.
   */
  recoverExecuting(ctx: RecoverExecutingContext): Promise<ExecutionResult>;
}

export type SendMethodHandlerRegistry = Record<SendMethod, SendMethodHandler<any>>;
