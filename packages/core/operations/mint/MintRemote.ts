import type { Amount } from '@cashu/cashu-ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import type { PrepareMintCommand } from './MintCommands.ts';
import type { PendingMintOperation, PendingOrLaterOperation } from './MintOperation.ts';
import type { MintIssuanceReceipt, MintRecoveryRecord, MintRequestRecord } from './MintRecovery.ts';

/** Preflight and mint I/O. All persistence is performed by the coordinator's transactions. */
export interface MintRemote {
  preflight(
    quote: MintQuote,
    amount: Amount,
  ): Promise<Pick<PrepareMintCommand, 'keysetId' | 'derive'>>;
  prepareRequest(
    operation: PendingMintOperation,
  ): Promise<{ request: MintRequestRecord; legacySignature?: string }>;
  issue(
    operation: PendingOrLaterOperation,
    recovery: MintRecoveryRecord,
  ): Promise<MintIssuanceReceipt[]>;
  restore(operation: PendingOrLaterOperation): Promise<MintIssuanceReceipt[]>;
  checkReceipts(
    operation: PendingOrLaterOperation,
    receipts: MintIssuanceReceipt[],
  ): Promise<MintIssuanceReceipt[]>;
  selectAmount(quote: MintQuote, available: Amount): Promise<Amount>;
  isTrusted(mintUrl: string): Promise<boolean>;
}
