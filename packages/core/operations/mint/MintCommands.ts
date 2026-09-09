import type { MintKeys, Proof } from '@cashu/cashu-ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import type { CoreProof } from '../../types.ts';
import type { MintMethod } from './MintMethodHandler.ts';
import type {
  MintOperation,
  MintOperationFailure,
  PendingMintOperation,
  PendingOrLaterOperation,
} from './MintOperation.ts';

/** Method validation is complete; deterministic outputs are allocated by the owning transaction. */
export type PreparedMintOperation<M extends MintMethod = MintMethod> = Omit<
  PendingMintOperation<M>,
  'outputData'
>;

export interface PrepareMintInput {
  operation: PreparedMintOperation;
  activeKeys: MintKeys;
  seed: Uint8Array;
}

export interface AuthorizeMintInput {
  operationId: string;
  timestamp: number;
}

export interface SettleMintInput {
  operation: PendingOrLaterOperation;
  proofs: Proof[];
  outcome: 'issued' | 'already-issued' | 'recovered';
  timestamp: number;
}

export interface ReturnMintToPendingInput {
  operation: PendingOrLaterOperation;
  error?: string;
  timestamp: number;
}

export interface FailMintInput {
  operation: PendingOrLaterOperation;
  failure: MintOperationFailure;
  timestamp: number;
}

export interface MintQuoteCommit {
  quote: MintQuote;
  changed: boolean;
}

export interface MintCommit {
  operation: MintOperation;
  changed: boolean;
  proofs: CoreProof[];
  quote?: MintQuoteCommit;
}

export interface PreparedMintCommit {
  operation: PendingMintOperation;
  counter: { mintUrl: string; keysetId: string; counter: number };
}

/** Domain mutations that can be composed inside one already-open transaction. */
export interface MintCommands {
  prepare(input: PrepareMintInput): Promise<PreparedMintCommit>;
  authorize(input: AuthorizeMintInput): Promise<MintCommit>;
  settle(input: SettleMintInput): Promise<MintCommit>;
  returnToPending(input: ReturnMintToPendingInput): Promise<MintCommit>;
  fail(input: FailMintInput): Promise<MintCommit>;
  observeQuote(quote: MintQuote): Promise<MintQuoteCommit>;
  deleteInit(operationId: string): Promise<void>;
}
