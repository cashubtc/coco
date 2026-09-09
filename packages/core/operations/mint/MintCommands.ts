import type { Amount, MintKeys } from '@cashu/cashu-ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import type { MintOperation, PendingMintOperation } from './MintOperation.ts';
import type { MintIssuanceReceipt, MintRecoveryRecord, MintRequestRecord } from './MintRecovery.ts';
import type { CoreProof } from '../../types.ts';

export interface PrepareMintInput {
  id: string;
  quote: MintQuote;
  amount: Amount;
  activeKeys: MintKeys;
  seed: Uint8Array;
}
export interface PreparedMintCommit {
  operation: PendingMintOperation;
  counter: { mintUrl: string; keysetId: string; counter: number };
}
export interface AuthorizeMintInput {
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
  prepare(input: PrepareMintInput): Promise<PreparedMintCommit>;
  authorize(input: AuthorizeMintInput): Promise<MintCommit>;
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
