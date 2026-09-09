import type { MintQuote } from '../models/MintQuote.ts';
import type { MintQuoteRef } from '../models/QuoteIdentity.ts';
import type { MintMethod } from '../operations/mint/MintMethodHandler.ts';
import type { MintOperation, MintOperationState } from '../operations/mint/MintOperation.ts';
import type { CoreProof } from '../types.ts';

export interface MintOperationQueries {
  getById(id: string): Promise<MintOperation | null>;
  getByState(state: MintOperationState): Promise<MintOperation[]>;
  getPending(): Promise<MintOperation[]>;
  getByMintUrl(mintUrl: string): Promise<MintOperation[]>;
  getByQuoteId(mintUrl: string, method: string, quoteId: string): Promise<MintOperation[]>;
}

export interface MintProofQueries {
  getProofBySecret(mintUrl: string, secret: string): Promise<CoreProof | null>;
}

/** Read-only access to canonical quotes. Import and observation are separate mutations. */
export interface MintQuoteQueries {
  requireMintQuoteRefForPrepare(ref: MintQuoteRef): Promise<MintQuote>;
  getMintQuote(mintUrl: string, method: MintMethod, quoteId: string): Promise<MintQuote | null>;
  getPendingMintQuotes(): Promise<MintQuote[]>;
}
