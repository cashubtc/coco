import type { MintMetadata } from '../../mints/MintMetadata.ts';
import type { Amount } from '@cashu/cashu-ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import type { PrepareMintInput } from './MintCommands.ts';
import type { PendingMintOperation, PendingOrLaterOperation } from './MintOperation.ts';
import type { MintIssuanceReceipt, MintRecoveryRecord, MintRequestRecord } from './MintRecovery.ts';

/** Preflight and mint I/O. All persistence is performed by the coordinator's transactions. */
export interface MintRemote {
  preflight(
    quote: MintQuote,
    amount: Amount,
    metadata: MintMetadata,
    seed: Uint8Array,
  ): Promise<Pick<PrepareMintInput, 'activeKeys' | 'seed'>>;
  prepareRequest(
    operation: PendingMintOperation,
    metadata: MintMetadata,
  ): Promise<{ request: MintRequestRecord; legacySignature?: string }>;
  issue(
    operation: PendingOrLaterOperation,
    recovery: MintRecoveryRecord,
    metadata: MintMetadata,
  ): Promise<MintIssuanceReceipt[]>;
  restore(
    operation: PendingOrLaterOperation,
    metadata: MintMetadata,
  ): Promise<MintIssuanceReceipt[]>;
  checkReceipts(
    operation: PendingOrLaterOperation,
    receipts: MintIssuanceReceipt[],
    metadata: MintMetadata,
  ): Promise<MintIssuanceReceipt[]>;
  selectAmount(quote: MintQuote, available: Amount, metadata: MintMetadata): Promise<Amount>;
}
