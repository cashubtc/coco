import type { Wallet, Proof, Token, P2PKOptions } from '@cashu/cashu-ts';
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
 * Structured P2PK send options accepted by Coco.
 *
 * `hashlock` is intentionally unavailable because cashu-ts treats hashlocked
 * P2PK options as HTLC/NUT-14 data, which this send method does not support.
 */
export type P2pkSendOptions = Omit<P2PKOptions, 'hashlock'> & {
  /** HTLC/NUT-14 hashlocks are out of scope for P2PK sends. */
  hashlock?: never;
};

/**
 * Payload accepted by the P2PK send method.
 *
 * `pubkey` is the legacy shorthand for locking outputs to a single public key.
 * Prefer `options` for full NUT-11 P2PK conditions such as `sigflag`,
 * multisig tags, locktime, and refund keys.
 */
export type P2pkSendMethodData =
  | {
      /** Legacy/direct shorthand for sending to one P2PK lock key. */
      pubkey: string;
      options?: never;
    }
  | {
      /** Full NUT-11 P2PK options accepted by Coco output builders. */
      options: P2pkSendOptions;
      pubkey?: never;
    };

/**
 * Registry of supported send methods and their payload shapes.
 * Extend via declaration merging if you need to add methods externally.
 *
 * Future methods may include:
 * - htlc: { hash: string; timeout: number } - HTLC locked tokens
 */
export interface SendMethodDefinitions {
  default: Record<string, never>;
  p2pk: P2pkSendMethodData;
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

/**
 * Result of a normal execution. A pending result must carry the token so the
 * caller can hand it to the recipient.
 */
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

/**
 * Result of recovering an executing operation. Recovery may legitimately reach a
 * pending state without being able to reconstruct the token, so it is optional.
 */
export type RecoveryResult =
  | {
      status: 'PENDING';
      pending: PendingSendOperation;
      token?: Token;
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
  recoverExecuting(ctx: RecoverExecutingContext): Promise<RecoveryResult>;
}

export type SendMethodHandlerRegistry = Record<SendMethod, SendMethodHandler<any>>;
