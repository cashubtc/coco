import type { MintOperation, MintOperationState } from '../operations/mint/MintOperation.ts';
import type { MintRecoveryRecord } from '../operations/mint/MintRecovery.ts';
import type { CoreProof } from '../types.ts';

/** Read-only capabilities; repository adapters satisfy these without another implementation. */
export interface MintOperationQueries {
  getById(id: string): Promise<MintOperation | null>;
  getByState(state: MintOperationState): Promise<MintOperation[]>;
  getByMintUrl(mintUrl: string): Promise<MintOperation[]>;
  getByQuoteId(mintUrl: string, method: string, quoteId: string): Promise<MintOperation[]>;
  getPending(): Promise<MintOperation[]>;
}
export interface MintRecoveryQueries {
  get(id: string): Promise<MintRecoveryRecord | null>;
  getAll(): Promise<MintRecoveryRecord[]>;
}

export interface MintProofQueries {
  getProofsByOperationId(mintUrl: string, operationId: string): Promise<CoreProof[]>;
}
