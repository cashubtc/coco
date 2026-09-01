import type {
  MintKeys,
  OutputDataCreator,
  OutputDataLike,
  P2PKOptions,
  P2PKTag,
  SigFlag,
  Token,
} from '@cashu/cashu-ts';
import { ProofValidationError } from '../../models/Error.ts';
import type { TopLevelNutCapability } from '../../services/MintService.ts';
import type { PreparedSendResult } from '../../transactions/send/TransactionalSendOperations.ts';
import type {
  ExecutingSendOperation,
  PendingSendOperation,
  PreparedSendOperation,
  SendOperation,
  InitSendOperation,
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

/** Method-specific preparation policy consumed by the authoritative Send transaction. */
export interface SendPreparationPlan {
  /** Skip exact-match selection and allocate swap outputs. */
  forceSwap: boolean;
  /**
   * Fixed, randomized outputs created during preflight. When omitted, the transaction allocates
   * deterministic send outputs and advances their counter positions.
   */
  fixedSendOutputs?: readonly OutputDataLike[];
}

/**
 * Safe preparation interface presented to a Send method handler. The handler owns method policy,
 * while `commit` owns every authoritative proof, counter, and operation write.
 */
export interface PrepareContext<M extends SendMethod = SendMethod> {
  operation: InitSendOperation & { method: M; methodData: SendMethodData<M> };
  activeKeys: MintKeys;
  outputDataCreator: OutputDataCreator;
  assertNutSupported(nut: TopLevelNutCapability, operation: string): Promise<void>;
  commit(plan: SendPreparationPlan): Promise<PreparedSendResult>;
}

export interface ExecuteContext {
  operation: PreparedSendOperation | PendingSendOperation;
  executeExact(): Promise<{ operation: PendingSendOperation; token: Token }>;
  executeSwap(): Promise<{ operation: PendingSendOperation; token: Token }>;
}

export interface PendingContext {
  operation: PendingSendOperation;
  checkPersistedSend(): Promise<void>;
}

export interface FinalizeContext {
  operation: SendOperation;
  completePersistedSend(): Promise<void>;
}

export interface RollbackContext {
  operation: SendOperation;
  reason: string;
  cancelPrepared(): Promise<void>;
  reclaimPendingDefault(): Promise<void>;
}

export interface RecoverExecutingContext {
  operation: ExecutingSendOperation;
  recoverPersistedSend(): Promise<void>;
}

export interface SendMethodHandler<M extends SendMethod = SendMethod> {
  prepare(ctx: PrepareContext<M>): Promise<PreparedSendResult>;
  execute(ctx: ExecuteContext): Promise<{ operation: PendingSendOperation; token: Token }>;
  finalize(ctx: FinalizeContext): Promise<void>;
  rollback(ctx: RollbackContext): Promise<void>;
  checkPending(ctx: PendingContext): Promise<void>;
  recoverExecuting(ctx: RecoverExecutingContext): Promise<void>;
}

export type SendMethodHandlerRegistry = Record<SendMethod, SendMethodHandler<any>>;
