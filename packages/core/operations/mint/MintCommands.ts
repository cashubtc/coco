import type { Amount } from '@cashu/cashu-ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import type { MintOperation, PendingMintOperation } from './MintOperation.ts';
import type { MintIssuanceReceipt, MintRecoveryRecord, MintRequestRecord } from './MintRecovery.ts';
import type { CoreProof } from '../../types.ts';
import type { SerializedOutputData } from '../../utils.ts';

export interface PrepareMintCommand {
  id: string;
  quote: MintQuote;
  amount: Amount;
  keysetId: string;
  /** Synchronous derivation bound to a preloaded seed and keyset. No I/O. */
  derive(counter: number): SerializedOutputData;
}
export interface PreparedMintCommit {
  operation: PendingMintOperation;
  counter: { mintUrl: string; keysetId: string; counter: number };
}
export interface AuthorizeMintCommand {
  operationId: string;
  request: MintRequestRecord;
  legacySignature?: string;
}
export interface MintCommit {
  operation: MintOperation;
  recovery?: MintRecoveryRecord;
  proofs: CoreProof[];
  changed: boolean;
}
export interface MintCommands {
  prepare(command: PrepareMintCommand): Promise<PreparedMintCommit>;
  authorize(command: AuthorizeMintCommand): Promise<MintCommit>;
  migrate(operationId: string): Promise<MintCommit>;
  applyEvidence(operationId: string, receipts: MintIssuanceReceipt[]): Promise<MintCommit>;
  reject(
    operationId: string,
    revision: number,
    error: string,
    useLegacy: boolean,
  ): Promise<MintCommit>;
  noteAmbiguity(operationId: string, revision: number, error: string): Promise<MintCommit>;
}
