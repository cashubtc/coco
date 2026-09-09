import type { Amount, Proof } from '@cashu/cashu-ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import type { PrepareMintInput } from './MintCommands.ts';
import type {
  MintExecutionResult,
  PendingMintObservationResult,
  RecoverExecutingResult,
} from './MintMethodHandler.ts';
import type {
  ExecutingMintOperation,
  InitMintOperation,
  PendingMintOperation,
  PendingOrLaterOperation,
} from './MintOperation.ts';

/** Method-specific preflight and remote effects; none of these methods persists Mint state. */
export interface MintRemote {
  isTrusted(mintUrl: string): Promise<boolean>;
  prepare(operation: InitMintOperation, quote: MintQuote): Promise<PrepareMintInput>;
  execute(operation: ExecutingMintOperation): Promise<MintExecutionResult>;
  recoverExecuting(
    operation: ExecutingMintOperation,
    localClaimabilityFacts: { finalizedAmount: Amount; reservedAmount: Amount },
  ): Promise<RecoverExecutingResult>;
  observePending(operation: PendingMintOperation): Promise<PendingMintObservationResult>;
  restoreOutputs(operation: PendingOrLaterOperation): Promise<Proof[]>;
}
