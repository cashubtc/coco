import type { MintMetadata } from '../../mints/MintMetadata.ts';
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
  prepare(
    operation: InitMintOperation,
    quote: MintQuote,
    metadata: MintMetadata,
    seed: Uint8Array,
  ): Promise<PrepareMintInput>;
  execute(operation: ExecutingMintOperation, metadata: MintMetadata): Promise<MintExecutionResult>;
  recoverExecuting(
    operation: ExecutingMintOperation,
    localClaimabilityFacts: { finalizedAmount: Amount; reservedAmount: Amount },
    metadata: MintMetadata,
  ): Promise<RecoverExecutingResult>;
  observePending(operation: PendingMintOperation): Promise<PendingMintObservationResult>;
  restoreOutputs(operation: PendingOrLaterOperation, metadata: MintMetadata): Promise<Proof[]>;
}
