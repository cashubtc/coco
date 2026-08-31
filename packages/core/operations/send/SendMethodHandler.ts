import type { Wallet, Proof, Token, P2PKOptions, P2PKTag, SigFlag } from '@cashu/cashu-ts';
import type { SendProofQueries } from '../../transactions/send/SendOperationQueries.ts';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { MintService } from '../../services/MintService';
import type { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { Logger } from '../../logging/Logger';
import { ProofValidationError } from '../../models/Error.ts';
import type {
  ExecutingSendOperation,
  PendingSendOperation,
  PreparedOrLaterOperation,
  RolledBackSendOperation,
} from './SendOperation';

/**
 * Structured P2PK send options accepted by Coco.
 *
 * `hashlock` is intentionally unavailable because cashu-ts treats hashlocked
 * P2PK options as HTLC/NUT-14 data, which this send method does not support.
 */
type LegacyP2pkSendOptions = {
  pubkey: string | string[];
  locktime?: number;
  refundKeys?: string[];
  requiredSignatures?: number;
  requiredRefundSignatures?: number;
  additionalTags?: P2PKTag[];
  blindKeys?: boolean;
  sigFlag?: SigFlag;
  /** HTLC/NUT-14 hashlocks are out of scope for P2PK sends. */
  hashlock?: never;
};

/**
 * P2PK options accepted by Coco. The legacy v4 shape remains supported and is converted to the v5
 * NUT-10 envelope before cashu-ts receives it.
 */
export type P2pkSendOptions =
  | (Omit<P2PKOptions, 'kind'> & { kind: 'P2PK' })
  | LegacyP2pkSendOptions;

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

/** Options that control a standard unlocked token send. */
export interface DefaultSendMethodData {
  /** Swap selected proofs even when they exactly match the requested amount. */
  forceSwap?: boolean;
}

/**
 * Registry of supported send methods and their payload shapes.
 * Extend via declaration merging if you need to add methods externally.
 *
 * Future methods may include:
 * - htlc: { hash: string; timeout: number } - HTLC locked tokens
 */
export interface SendMethodDefinitions {
  default: DefaultSendMethodData;
  p2pk: P2pkSendMethodData;
}

export type SendMethod = keyof SendMethodDefinitions;

export type SendMethodData<M extends SendMethod = SendMethod> = SendMethodDefinitions[M];

export function resolveP2pkOptions(methodData: SendMethodData<'p2pk'>): P2PKOptions {
  if ('options' in methodData && methodData.options) {
    if ((methodData.options as { hashlock?: unknown }).hashlock !== undefined) {
      throw new ProofValidationError('P2PK send does not support hashlock/HTLC options');
    }
    if ('kind' in methodData.options) {
      if (methodData.options.kind !== 'P2PK') {
        throw new ProofValidationError('P2PK send does not support hashlock/HTLC options');
      }
      return methodData.options;
    }

    const pubkeys = Array.isArray(methodData.options.pubkey)
      ? methodData.options.pubkey
      : [methodData.options.pubkey];
    const [data, ...additionalPubkeys] = pubkeys;
    if (!data) {
      throw new ProofValidationError('P2PK send requires at least one lock pubkey');
    }
    const { pubkey: _pubkey, hashlock: _hashlock, ...conditions } = methodData.options;
    return {
      kind: 'P2PK',
      data,
      ...conditions,
      ...(additionalPubkeys.length > 0 ? { pubkeys: additionalPubkeys } : {}),
    };
  }

  if ('pubkey' in methodData && methodData.pubkey) {
    return { kind: 'P2PK', data: methodData.pubkey };
  }

  throw new ProofValidationError('P2PK send requires P2PK options or a pubkey in methodData');
}

// ---------------------------------------------------------------------------
// Contexts / Results
// ---------------------------------------------------------------------------

export interface BaseHandlerDeps {
  proofRepository: SendProofQueries;
  proofService: ProofService;
  walletService: WalletService;
  mintService: MintService;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
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
